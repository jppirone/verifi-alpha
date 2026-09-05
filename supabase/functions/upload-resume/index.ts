// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — step 1 of 3.
//
// VISION FALLBACK FOR STITCHED MULTI-PAGE IMAGES (added after tonight's real investigation — see
// test-vision-extract, same session): tesseract-wasm's CPU-time kill (2s CPU time, see below) is a
// hard isolate termination, not a catchable JS exception — confirmed live tonight, no exception was
// ever thrown for the normal try/catch around runOcr() to catch. That rules out a "try tesseract,
// catch failure, fall back to vision" structure within one invocation: if tesseract itself is what
// blows the CPU budget mid-word-recognition, the isolate dies before any catch block runs. The only
// place a fallback decision CAN be made safely is before calling tesseract at all.
//
// The real killed case tonight (a synthetic stitched multi-page resume, confirmed via
// test-vision-extract re-runs) was a very tall, narrow composite — multiple page-images stacked
// vertically into one file. The client already caps the long edge at 2200px (see
// onPickResumeFile's canvas-decode comment in candidate.html), so raw pixel count alone doesn't
// reliably separate a normal single-page portrait resume (which can ALSO land near 2200x1700,
// ~3.7MP, after that cap) from a stitched composite — capping the long edge trades width for height
// on a tall image, so a stitch can end up with LOWER total area than a normal page. Aspect ratio is
// the signal that actually matches the failure mode: stacking N pages vertically multiplies height
// by roughly N while width stays fixed, so a 2+ page stitch lands at long:short ratio north of 2.0
// where no normal single-page photo or scan (portrait ~1.3, landscape ~0.77) would ever sit. This
// threshold is a reasoned default from tonight's one real data point, not a tuned production
// constant — revisit with more real examples as they accumulate.
//
// When the ratio trips the threshold, this skips tesseract-wasm entirely and sends the already-
// in-hand sanitized JPEG bytes straight to Claude Sonnet 5 vision for one-call structured
// extraction (proven tonight: real CPU-kill avoidance, since it's a network-bound API call rather
// than local CPU-bound work, plus real per-call cost pulled from actual token usage — nothing
// estimated). Because vision returns the FINAL structured shape directly rather than raw OCR text,
// this path also performs the insert_resume_extraction RPC itself and sets extraction_status
// straight to 'extracted' — skipping the 'ocr_done' intermediate state and extract-resume-fields'
// separate Haiku call entirely for these documents (two LLM calls for one job would be pure waste
// once vision can do the whole thing in one pass). extract-resume-fields has been updated to
// short-circuit cleanly if it's called anyway on an already-'extracted' row, since candidate.html's
// upload → extract chain calls it unconditionally regardless of which path ran here.
//
// SCOPE DECISION (deliberate, backed out later via config, not a hardcoded restriction): alpha
// accepts image uploads only. PDF rasterization inside an Edge Function is a real, unsolved
// problem (same shape as the Tesseract-in-Deno problem this session already fought through) and is
// explicitly out of scope for this build. Re-enabling PDF later is meant to be a one-line change to
// this list plus wiring an actual rasterization step into the sanitize stage — nothing else here
// should need to change, which is why this is one constant and not scattered validation logic.
const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
];

// WHY THIS TAKES email_verification_id, NOT candidate_id — for the FIRST upload:
// candidates rows are created only at confirm-verification time (zero-trace-for-abandoned-signups
// hygiene already used elsewhere in this project — an abandoned signup that never clicks the email
// link leaves no permanent candidates row). Upload happens earlier, at isEntry/isPreview, before
// that row exists. This mirrors the existing phone/full_name pattern exactly: staged against the
// email_verifications row, only linked to a real candidate at confirm time —
// backfill_resume_pipeline_candidate_id() (called from confirm-verification) does that linking.
// candidate_id on resume_documents (and every child table) stays NULL until then.
//
// candidate_id IS accepted directly as an alternative, for a real, later case: "Try a different
// file" on the resumeConfirm screen, reached only after confirmation, when a real candidate_id
// already exists. Re-uploading against the ORIGINAL email_verification_id there would be wrong,
// not just redundant — backfill_resume_pipeline_candidate_id() only ever runs once, at confirm
// time, so a new row staged under that same id would never get candidate_id backfilled and would
// silently never appear on get-resume-extraction's candidate_id-keyed lookup. Exactly one of
// email_verification_id / candidate_id is required; whichever is given determines which existence
// check runs and which column the new row is linked through — never both, never neither.
//
// WHY OCR RUNS HERE, NOT IN extract-resume-fields:
// The proven OCR pipeline (test-tesseract-wasm-word-columns, tonight) takes client-decoded RGBA —
// the browser draws the image to a <canvas> and reads pixels back with getImageData(). That
// decoded-pixel data only exists at the moment the browser does that decode. extract-resume-fields
// operating on a file already sitting in Storage would mean decoding a PNG/JPEG *inside Deno* to
// get RGBA — Deno has no canvas and no built-in image codec, which is a real, separate unsolved
// problem, not a detail. Rather than re-derive that problem, this function reuses the browser's
// decode: the SAME client-side canvas pass that flattens/strips EXIF for the sanitized render also
// reads out the RGBA this function needs, and both are uploaded together in one request. This is
// also why extraction_status's real states (pending → ocr_done → extracted → failed) put "ocr_done"
// before any separate extraction step — that boundary is the authority here, not either function's
// one-line prose description, which overlap imprecisely.
//
// OCR + word-level column-clustering logic below is ported directly from
// supabase/functions/test-tesseract-wasm-word-columns/index.ts (proven, deployed, live-tested
// tonight — see that function's commit for the full real result). One real fix applied here that
// the test function's own header explicitly flagged and left in place for the test record: blank/
// whitespace-only word boxes (Tesseract reports these for ruled lines and similar page furniture)
// are now filtered out before clustering, which the test's reconstructByWordClustering() did not
// do. Not reflagging that as a new finding — it was already documented as a known, trivially-
// fixable gap; this is that fix, applied because production code has no reason to preserve it.
const WASM_URL = "https://cdn.jsdelivr.net/npm/tesseract-wasm@0.11.0/dist/tesseract-core.wasm";
const MODEL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";

// long:short pixel-dimension ratio above which an image is treated as a stitched multi-page
// composite and routed to vision instead of tesseract-wasm — see header comment above for why.
const STITCHED_ASPECT_RATIO_THRESHOLD = 2.0;

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Sonnet 5, not Haiku (contrast with extract-resume-fields): reading a real, possibly messy photo
// directly is a harder task than parsing already-clean OCR text, and this path only runs on the
// rare stitched/oversized case, not every resume — the extra cost isn't paid at normal volume.
const VISION_MODEL = "claude-sonnet-5";

// Same schema/field definitions as extract-resume-fields's prompt (keep both in sync if the schema
// changes), plus one addition: this path reads the image directly, so it can also describe
// non-text graphical content (language-proficiency bars/icons) that OCR structurally cannot see.
const VISION_EXTRACTION_PROMPT = `You are extracting structured data directly from the attached image of a resume. Read the document as printed — do not invent information that is not actually present in the image in some recognizable form.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
  "work_history": [
    { "company": string, "title": string, "start_date": string, "end_date": string,
      "job_responsibilities": string, "extraction_confidence": "high" | "medium" | "low" }
  ],
  "education": [
    { "institution": string, "degree": string, "field_of_study": string,
      "start_date": string, "end_date": string, "extraction_confidence": "high" | "medium" | "low" }
  ],
  "certifications": [
    { "name": string, "issuing_body": string, "issue_date": string, "expiration_date": string,
      "extraction_confidence": "high" | "medium" | "low" }
  ],
  "freeform": [
    { "section_type": "summary" | "hobbies_other" | "needs_review", "content": string }
  ]
}

FIELD AND CATEGORY DEFINITIONS — read carefully, these are not interchangeable buckets:

- work_history = PAID EMPLOYMENT ONLY. If a role reads as unpaid — volunteer work, an unpaid
  internship explicitly described as unpaid, community service — do NOT put it in work_history.
  Instead add ONE entry to "freeform" with section_type "needs_review" whose content plainly
  describes the excluded role (organization, title, dates, and why you excluded it) so a human
  reviews it rather than it being silently dropped. Do not guess when pay status is ambiguous —
  only exclude when the text itself signals "unpaid" or "volunteer"; otherwise include it normally.

- Work-history section headers vary by resume — "Experience", "Work History", "Professional
  Experience", "Employment History", "Job Description", and similar all describe the SAME concept
  and all belong in work_history. Don't treat different header wording as different categories.

- education = DEGREE-GRANTING PROGRAMS ONLY (e.g. B.A., B.S., M.S., MBA, Ph.D., Associate's).

- certifications = standalone credentials: certifications, licenses, bootcamps, and similar
  short-form credentials that are NOT part of a degree program. A coding bootcamp goes in
  certifications UNLESS the resume text itself frames it as part of a degree program (e.g. a
  university-issued certificate within a degree track) — read the actual framing, don't assume.

- Deduplication: if the same role or credential appears more than once anywhere in the document
  (e.g. listed once under "Experience" and again under a separate "Leadership" or "Highlights"
  section), extract it ONCE. Do not create duplicate entries for repeated mentions of the same
  underlying fact.

- "summary" (freeform) = any professional summary / objective / about-me blurb at the top of the
  resume. "hobbies_other" (freeform) = interests, hobbies, volunteer/community activities not
  already handled by the needs_review rule above, and any other content that doesn't fit work
  history, education, or certifications. Summary and hobbies/other content must NEVER be placed
  into work_history, education, or certifications, even if it superficially resembles one of them.
  If the resume shows language proficiency as icons, bars, dots, or other non-text graphics rather
  than words, describe what you can determine from the graphic (e.g. the language name and an
  approximate level like "native/fluent/conversational/basic" if the graphic clearly conveys a
  level) in a "summary" or "hobbies_other" freeform entry — do not silently drop it, and do not
  invent a precision level the graphic doesn't actually convey.

DATES: use YYYY-MM-DD when the resume gives a specific day (rare), YYYY-MM-01 when it gives a
month and year, YYYY-01-01 when it gives only a year. If a role/program is current/ongoing
("Present", "Current", no end given), set end_date to an empty string "" — do not invent a real
end date. If a date is entirely absent or unrecoverable, use an empty string "" for that field, not
a guess.

If a category has no entries, return an empty array for it — do not omit the key.`;

type ExtractionResult = {
  work_history: Array<{ company: string; title: string; start_date: string; end_date: string; job_responsibilities: string; extraction_confidence: string }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; start_date: string; end_date: string; extraction_confidence: string }>;
  certifications: Array<{ name: string; issuing_body: string; issue_date: string; expiration_date: string; extraction_confidence: string }>;
  freeform: Array<{ section_type: string; content: string }>;
};

function isValidExtraction(x: unknown): x is ExtractionResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.work_history) && Array.isArray(o.education) &&
    Array.isArray(o.certifications) && Array.isArray(o.freeform);
}

// Sends the sanitized JPEG bytes already in hand straight to vision — no Storage round-trip
// needed, unlike test-vision-extract which had to fetch by path. Throws on any failure; caller is
// responsible for marking the document 'failed'. max_tokens=16000 and no `temperature` param are
// both load-bearing: Sonnet 5 rejects `temperature` outright (400), and 16000 was the number that
// stopped real truncation (`stop_reason: "max_tokens"`) seen at 8192 during tonight's testing —
// thinking-token overhead varies run to run and eats into the same budget as the answer.
async function runVisionExtraction(sanitizedBase64: string): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 16000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sanitizedBase64 } },
          { type: "text", text: VISION_EXTRACTION_PROMPT },
        ],
      }],
    }),
  });
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }

  const claudeData = await claudeRes.json();
  // Sonnet 5 uses adaptive thinking by default — content[0] is often a "thinking" block, not the
  // answer, so find the actual text block rather than assuming index 0.
  const textBlock = (claudeData?.content ?? []).find((b: { type?: string }) => b.type === "text");
  const rawText: string = textBlock?.text ?? "";
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`malformed_vision_response: ${rawText.slice(0, 500)}`);
  }
  if (!isValidExtraction(parsed)) {
    throw new Error("vision_response_wrong_shape");
  }
  return parsed;
}

type TextItem = { rect: { left: number; top: number; right: number; bottom: number }; confidence: number; text: string };

function reconstructByWordClustering(words: TextItem[]): string {
  const real = words.filter((w) => w.text.trim().length > 0);
  if (real.length === 0) return "";
  const withLeft = real.map((w) => ({ text: w.text, left: w.rect.left, top: w.rect.top }));
  const sortedLefts = [...withLeft].sort((a, b) => a.left - b.left);
  let maxGap = -1, gapIdx = -1;
  for (let i = 1; i < sortedLefts.length; i++) {
    const gap = sortedLefts[i].left - sortedLefts[i - 1].left;
    if (gap > maxGap) {
      maxGap = gap;
      gapIdx = i;
    }
  }
  const boundary = gapIdx > 0 ? (sortedLefts[gapIdx - 1].left + sortedLefts[gapIdx].left) / 2 : -Infinity;

  const col0 = withLeft.filter((w) => w.left <= boundary);
  const col1 = withLeft.filter((w) => w.left > boundary);

  function reconstructColumn(colWords: typeof withLeft): string[] {
    const sorted = [...colWords].sort((a, b) => a.top - b.top);
    const linesOut: (typeof withLeft)[] = [];
    let current: typeof withLeft = [];
    let currentTop: number | null = null;
    for (const w of sorted) {
      if (currentTop === null || Math.abs(w.top - currentTop) <= 6) {
        current.push(w);
        currentTop = current.reduce((s, x) => s + x.top, 0) / current.length;
      } else {
        linesOut.push(current);
        current = [w];
        currentTop = w.top;
      }
    }
    if (current.length) linesOut.push(current);
    return linesOut.map((line) => line.sort((a, b) => a.left - b.left).map((w) => w.text).join(" "));
  }

  const col0Lines = reconstructColumn(col0);
  const col1Lines = reconstructColumn(col1);
  // If clustering found effectively one column (no real gap), col1 will be empty — don't glue a
  // spurious blank second block onto genuinely single-column resumes.
  return col1Lines.length ? col0Lines.join("\n") + "\n\n" + col1Lines.join("\n") : col0Lines.join("\n");
}

async function runOcr(rgbaBytes: Uint8Array, width: number, height: number): Promise<string> {
  const [wasmRes, modelRes] = await Promise.all([fetch(WASM_URL), fetch(MODEL_URL)]);
  if (!wasmRes.ok || !modelRes.ok) throw new Error("ocr_asset_fetch_failed");
  const wasmBinary = new Uint8Array(await wasmRes.arrayBuffer());
  const modelBytes = new Uint8Array(await modelRes.arrayBuffer());

  const engine = await createOCREngine({ wasmBinary });
  engine.loadModel(modelBytes);
  engine.loadImage({ data: rgbaBytes, width, height });
  const wordBoxes = engine.getTextBoxes("word") as unknown as TextItem[];
  const text = reconstructByWordClustering(wordBoxes);
  engine.destroy();
  return text;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const body = await req.json();
      const {
        email_verification_id,
        candidate_id,
        original_filename,
        mime_type,
        original_base64,       // untouched original file bytes, base64
        sanitized_base64,      // client-canvas-rendered, EXIF-stripped JPEG, base64
        rgba_base64,           // raw RGBA pixels from the SAME canvas decode, for OCR
        width,
        height,
      } = body;

      const hasEv = !!email_verification_id && typeof email_verification_id === "string";
      const hasCand = !!candidate_id && typeof candidate_id === "string";
      if (!hasEv && !hasCand) {
        return new Response(JSON.stringify({ ok: false, error: "email_verification_id or candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!mime_type || !ACCEPTED_MIME_TYPES.includes(mime_type)) {
        return new Response(JSON.stringify({
          ok: false,
          error: "unsupported_file_type",
          message: `This file type isn't supported yet. Please upload one of: ${ACCEPTED_MIME_TYPES.join(", ")}.`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (!original_base64 || !sanitized_base64 || !rgba_base64 || !width || !height) {
        return new Response(JSON.stringify({
          ok: false,
          error: "missing_upload_data",
          message: "Upload was incomplete (this browser may not support processing this photo format). Try a JPEG or PNG.",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // Confirm this is a real row before accepting an upload against it — a clear error beats a
      // resume silently orphaned under a bogus id. candidate_id takes priority when both happen to
      // be present (shouldn't normally happen, but candidate_id is the more specific, later-stage
      // identifier if it does).
      let linkColumn: "candidate_id" | "email_verification_id";
      let linkValue: string;
      if (hasCand) {
        const { data: candRow, error: candErr } = await supabase
          .from("candidates").select("id").eq("id", candidate_id).single();
        if (candErr || !candRow) {
          return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        linkColumn = "candidate_id";
        linkValue = candidate_id;
      } else {
        const { data: evRow, error: evErr } = await supabase
          .from("email_verifications")
          .select("id, confirmed_at")
          .eq("id", email_verification_id)
          .single();
        if (evErr || !evRow) {
          return new Response(JSON.stringify({ ok: false, error: "email_verification_not_found" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        linkColumn = "email_verification_id";
        linkValue = email_verification_id;
      }

      const docId = crypto.randomUUID();
      const ext = mime_type.split("/")[1] || "bin";
      const originalPath = `${linkValue}/${docId}/original.${ext}`;
      const sanitizedPath = `${linkValue}/${docId}/sanitized.jpg`;

      const originalBytes = base64ToBytes(original_base64);
      const sanitizedBytes = base64ToBytes(sanitized_base64);

      const [origUpload, sanUpload] = await Promise.all([
        supabase.storage.from(BUCKET).upload(originalPath, originalBytes, { contentType: mime_type, upsert: false }),
        supabase.storage.from(BUCKET).upload(sanitizedPath, sanitizedBytes, { contentType: "image/jpeg", upsert: false }),
      ]);
      if (origUpload.error || sanUpload.error) {
        return new Response(JSON.stringify({
          ok: false, error: "storage_upload_failed",
          detail: { original: origUpload.error?.message, sanitized: sanUpload.error?.message },
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: docRow, error: insertErr } = await supabase
        .from("resume_documents")
        .insert({
          id: docId,
          [linkColumn]: linkValue,
          original_storage_path: originalPath,
          original_filename: original_filename ?? null,
          mime_type,
          sanitized_render_path: sanitizedPath,
          extraction_status: "pending",
        })
        .select()
        .single();
      if (insertErr) {
        return new Response(JSON.stringify({ ok: false, error: "db_insert_failed", detail: insertErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const w = Number(width), h = Number(height);
      const aspectRatio = Math.max(w, h) / Math.min(w, h);
      const useVisionFallback = aspectRatio > STITCHED_ASPECT_RATIO_THRESHOLD;

      if (useVisionFallback) {
        console.log(`upload-resume: ${docId} routed to vision fallback (${w}x${h}, ratio ${aspectRatio.toFixed(2)})`);
        let extraction: ExtractionResult;
        try {
          extraction = await runVisionExtraction(sanitized_base64);
        } catch (visionErr) {
          await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
          return new Response(JSON.stringify({ ok: false, error: "vision_extraction_failed", detail: String(visionErr), resume_document_id: docId }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { error: rpcErr } = await supabase.rpc("insert_resume_extraction", {
          p_resume_document_id: docId,
          p_candidate_id: docRow.candidate_id,
          p_work_history: extraction.work_history,
          p_education: extraction.education,
          p_certifications: extraction.certifications,
          p_freeform: extraction.freeform,
        });
        if (rpcErr) {
          await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
          return new Response(JSON.stringify({ ok: false, error: "insert_failed", detail: rpcErr.message, resume_document_id: docId }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { error: statusErr } = await supabase
          .from("resume_documents")
          .update({ extraction_status: "extracted", extracted_at: new Date().toISOString() })
          .eq("id", docId);
        if (statusErr) {
          return new Response(JSON.stringify({ ok: false, error: "status_update_failed", detail: statusErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: signedVision } = await supabase.storage.from(BUCKET).createSignedUrl(originalPath, 3600);
        return new Response(JSON.stringify({
          ok: true,
          resume_document_id: docId,
          extraction_status: "extracted",
          extraction_method: "vision",
          original_signed_url: signedVision?.signedUrl ?? null,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let ocrText = "";
      try {
        const rgbaBytes = base64ToBytes(rgba_base64);
        ocrText = await runOcr(rgbaBytes, w, h);
      } catch (ocrErr) {
        await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
        return new Response(JSON.stringify({ ok: false, error: "ocr_failed", detail: String(ocrErr), resume_document_id: docId }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: updateErr } = await supabase
        .from("resume_documents")
        .update({ ocr_raw_text: ocrText, extraction_status: "ocr_done" })
        .eq("id", docId);
      if (updateErr) {
        return new Response(JSON.stringify({ ok: false, error: "db_update_failed", detail: updateErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Short-lived signed URL so the client can render the original immediately on the confirm
      // screen without the bucket being public.
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(originalPath, 3600);

      return new Response(JSON.stringify({
        ok: true,
        resume_document_id: docId,
        extraction_status: "ocr_done",
        original_signed_url: signed?.signedUrl ?? null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
