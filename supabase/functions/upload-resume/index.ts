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

// WHY THIS TAKES email_verification_id, NOT candidate_id:
// candidates rows are created only at confirm-verification time (zero-trace-for-abandoned-signups
// hygiene already used elsewhere in this project — an abandoned signup that never clicks the email
// link leaves no permanent candidates row). Upload happens earlier, at isEntry/isPreview, before
// that row exists. This mirrors the existing phone/full_name pattern exactly: staged against the
// email_verifications row, only linked to a real candidate at confirm time —
// backfill_resume_pipeline_candidate_id() (called from confirm-verification) does that linking.
// candidate_id on resume_documents (and every child table) stays NULL until then.
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
        original_filename,
        mime_type,
        original_base64,       // untouched original file bytes, base64
        sanitized_base64,      // client-canvas-rendered, EXIF-stripped JPEG, base64
        rgba_base64,           // raw RGBA pixels from the SAME canvas decode, for OCR
        width,
        height,
      } = body;

      if (!email_verification_id || typeof email_verification_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "email_verification_id is required" }), {
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

      // Confirm this is a real, still-open email_verifications row before accepting an upload
      // against it — a clear error beats a resume silently orphaned under a bogus id.
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

      const docId = crypto.randomUUID();
      const ext = mime_type.split("/")[1] || "bin";
      const originalPath = `${email_verification_id}/${docId}/original.${ext}`;
      const sanitizedPath = `${email_verification_id}/${docId}/sanitized.jpg`;

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
          email_verification_id,
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

      let ocrText = "";
      try {
        const rgbaBytes = base64ToBytes(rgba_base64);
        ocrText = await runOcr(rgbaBytes, Number(width), Number(height));
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
