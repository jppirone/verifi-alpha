// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — step 2 of 3.
//
// Takes a resume_documents.id whose extraction_status is already 'ocr_done' (OCR itself runs in
// upload-resume — see that function's header for why: the RGBA input the proven tesseract-wasm +
// word-clustering pipeline needs only exists at the moment of client-side canvas decode, and
// re-deriving it from a stored file here would mean decoding images inside Deno, a separate,
// unsolved problem). This function's job is exactly one thing: turn ocr_raw_text into structured
// draft rows via a single Claude call, insert them atomically, done.
//
// "Never partial-inserts" is enforced by insert_resume_extraction(), a Postgres function
// (see migrations/20260903000000_resume_pipeline.sql) whose body runs in one transaction — this
// function parses and fully validates Claude's JSON first, then makes exactly one RPC call with
// everything it needs to insert. Any failure before that call, or the RPC call itself failing,
// leaves zero rows behind and sets extraction_status = 'failed'.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Haiku 4.5, not Sonnet, deliberately: structured extraction from clear instructions is well
// within a smaller model's ability, and at real Anthropic pricing (confirmed via the claude-api
// skill, not recalled from memory) Haiku is $1/$5 per MTok in/out vs Sonnet 5's $2/$10 — half the
// per-resume cost for a task that doesn't need Sonnet's extra capability. User's own call after
// seeing the real cost estimate for this specific key (~$0.01-0.02/resume on Sonnet, roughly
// half that here) — this is the one piece of the pipeline that spends real, metered API money,
// separate from this coding session's own usage.
const CLAUDE_MODEL = "claude-haiku-4-5";

// Extraction prompt — states the target schema and field definitions explicitly rather than
// relying on the model to infer categories, per instructions. Every rule below came from the build
// spec directly; none of this is inferred/assumed by this function.
function buildExtractionPrompt(ocrText: string): string {
  return `You are extracting structured data from the raw OCR text of a resume. The OCR text below
may contain recognition errors (misread characters, words glued together, minor garbling) — do
your best to read through that, but do not invent information that is not actually present in the
text in some recognizable form.

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

DATES: use YYYY-MM-DD when the resume gives a specific day (rare), YYYY-MM-01 when it gives a
month and year, YYYY-01-01 when it gives only a year. If a role/program is current/ongoing
("Present", "Current", no end given), set end_date to an empty string "" — do not invent a real
end date. If a date is entirely absent or unrecoverable, use an empty string "" for that field, not
a guess.

If a category has no entries, return an empty array for it — do not omit the key.

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
}

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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY not configured yet" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
      const { resume_document_id } = await req.json();
      if (!resume_document_id) {
        return new Response(JSON.stringify({ ok: false, error: "resume_document_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: doc, error: docErr } = await supabase
        .from("resume_documents")
        .select("id, candidate_id, ocr_raw_text, extraction_status")
        .eq("id", resume_document_id)
        .single();
      if (docErr || !doc) {
        return new Response(JSON.stringify({ ok: false, error: "resume_document_not_found", detail: docErr?.message }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // upload-resume's vision fallback (stitched/oversized images) writes extraction rows and
      // sets extraction_status to 'extracted' directly, skipping 'ocr_done' entirely — but
      // candidate.html's upload → extract chain calls this function unconditionally afterward
      // regardless of which path ran. Short-circuit cleanly here rather than let that call fall
      // through to the ocr_raw_text check below and error on a document that was never meant to
      // have OCR text in the first place.
      if (doc.extraction_status === "extracted") {
        return new Response(JSON.stringify({ ok: true, resume_document_id, extraction_status: "extracted", already_extracted: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!doc.ocr_raw_text) {
        return new Response(JSON.stringify({ ok: false, error: "ocr_not_done", message: "This document has no OCR text yet." }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const prompt = buildExtractionPrompt(doc.ocr_raw_text);

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!claudeRes.ok) {
        await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", resume_document_id);
        const detail = await claudeRes.text().catch(() => "");
        return new Response(JSON.stringify({ ok: false, error: "claude_call_failed", status: claudeRes.status, detail: detail.slice(0, 2000) }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const claudeData = await claudeRes.json();
      const rawText: string = claudeData?.content?.[0]?.text ?? "";

      // Model is instructed to return ONLY JSON, but strip any accidental code-fence wrapping
      // before parsing rather than trusting that instruction blindly.
      const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", resume_document_id);
        return new Response(JSON.stringify({ ok: false, error: "malformed_llm_response", raw: rawText.slice(0, 2000) }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!isValidExtraction(parsed)) {
        await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", resume_document_id);
        return new Response(JSON.stringify({ ok: false, error: "malformed_llm_response", detail: "response did not match expected shape", raw: rawText.slice(0, 2000) }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: rpcErr } = await supabase.rpc("insert_resume_extraction", {
        p_resume_document_id: resume_document_id,
        p_candidate_id: doc.candidate_id,
        p_work_history: parsed.work_history,
        p_education: parsed.education,
        p_certifications: parsed.certifications,
        p_freeform: parsed.freeform,
      });
      if (rpcErr) {
        await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", resume_document_id);
        return new Response(JSON.stringify({ ok: false, error: "insert_failed", detail: rpcErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: statusErr } = await supabase
        .from("resume_documents")
        .update({ extraction_status: "extracted", extracted_at: new Date().toISOString() })
        .eq("id", resume_document_id);
      if (statusErr) {
        return new Response(JSON.stringify({ ok: false, error: "status_update_failed", detail: statusErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        resume_document_id,
        extraction_status: "extracted",
        counts: {
          work_history: parsed.work_history.length,
          education: parsed.education.length,
          certifications: parsed.certifications.length,
          freeform: parsed.freeform.length,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
