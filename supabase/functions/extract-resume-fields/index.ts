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
//
// Item 2 (2026-09-08 regression session): certifications carve-out + de-collided NEVER FABRICATE
// example below, mirroring the same fix in rasterize-pdf-page/index.ts (this function's own header
// there has the full story — reproduced live against a real resume whose genuine, itemized
// certifications list shared vocabulary with the rule's own worked example and got misclassified
// into needs_review as a result). This function's copy of that rule was missing the carve-out
// entirely before this fix — only rasterize-pdf-page's PDF path had it (added in an earlier,
// narrower fix verified against a different document). Applied here too so the same bug can't
// resurface via the image-upload path, which is the one that actually calls this function.
function buildExtractionPrompt(ocrText: string): string {
  return `You are extracting structured data from the raw OCR text of a resume. The OCR text below
may contain recognition errors (misread characters, words glued together, minor garbling) — do
your best to read through that, but do not invent information that is not actually present in the
text in some recognizable form.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
  "work_history": [
    { "company": string, "title": string, "location": string, "start_date": string, "end_date": string,
      "job_responsibilities": string, "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "education": [
    { "institution": string, "degree": string, "field_of_study": string, "location": string,
      "start_date": string, "end_date": string, "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "certifications": [
    { "name": string, "issuing_body": string, "issue_date": string, "expiration_date": string,
      "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "skills": [ string ],
  "skills_position": number | null,
  "freeform": [
    { "section_type": "summary" | "hobbies_other" | "needs_review", "heading": string, "content": string, "position": number }
  ]
}

ZERO-LOSS RULE (hard requirement — read this before classifying anything): every visible heading,
paragraph, table, or list on the page must be accounted for somewhere in your output. Never omit
visible content for any reason. Classify it into a real category (work_history, education,
certifications, skills) when it genuinely belongs there; otherwise it goes into "freeform" as
"summary" or "hobbies_other" only when it actually matches one of those two definitions below, and
as "needs_review" for everything else that doesn't fit anywhere — needs_review is the universal
fallback, always available, always correct when nothing else fits. Never force content into a
category it doesn't genuinely belong in just to give it a home.

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

- work_history's "location" field = the employer's city/state (or city/country outside the US) as
  printed on the resume, near the company name or role, e.g. "Austin, TX" — same rule as education's
  "location" field below, just for the employer instead of the institution. Copy it verbatim in
  whatever form it appears; use an empty string "" when no location is given for that role — never
  infer or guess one from the employer's real-world location.

- education = DEGREE-GRANTING PROGRAMS ONLY (e.g. B.A., B.S., M.S., MBA, Ph.D., Associate's).

- education's "location" field = the institution's city/state (or city/country outside the US) as
  printed on the resume, near the institution's name, e.g. "Gainesville, FL". Copy it verbatim in
  whatever form it appears — do not reformat, abbreviate, or expand it. Use an empty string "" when
  no location is given for that institution — never infer or guess one from the institution's real-
  world location; only what's actually printed counts.

- certifications = standalone credentials: certifications, licenses, bootcamps, and similar
  short-form credentials that are NOT part of a degree program. A coding bootcamp goes in
  certifications UNLESS the resume text itself frames it as part of a degree program (e.g. a
  university-issued certificate within a degree track) — read the actual framing, don't assume.
  A bulleted/itemized LIST of named credentials directly under a certifications-style heading (e.g.
  "Certifications", "Professional Certifications", "AI & Emerging Technology Certifications") IS
  the "real, specific items listed under it" case the NEVER FABRICATE rule below asks you to extract
  — each bullet becomes its own certifications entry with that bullet's own text as "name", even when
  a DIFFERENT part of the same resume (e.g. an EDUCATION section's "Continuing Education" line) later
  describes the same body of coursework in one narrative sentence. THE DECISIVE SIGNAL IS SHAPE, NOT
  WORDING: two or more distinctly named items separated by bullets, semicolons, or line breaks under
  one heading is always a real list to extract, item by item — this holds even when the heading or a
  nearby summary sentence elsewhere on the page happens to share vocabulary (a provider name, an
  hours figure, a topic word) with the NEVER FABRICATE rule's own worked example below. Matching that
  example's WORDING is never a reason to withhold extraction from an itemized list that is otherwise
  real — only the ABSENCE of individually named items is.

- skills = a FLAT LIST of individual skill, competency, or keyword terms presented as a list rather
  than prose — commonly under a heading like "Skills," "Core Competencies," "Technical Skills,"
  "Areas of Expertise," "Key Skills," or similar, but judge this by SHAPE, not by header name: if a
  section reads as a list of short terms/phrases rather than sentences, it belongs in skills
  regardless of what its heading is called (or even with no heading at all). Each distinct term or
  short phrase becomes its own string in the "skills" array, copied verbatim — don't rename, merge,
  split, or normalize wording, and don't alphabetize or reorder; keep the resume's own order. The
  reverse also holds: if content under a "Skills"-like heading is actually written as prose/full
  sentences rather than a list of terms, it does NOT belong in skills — classify it by what it
  actually is instead (summary, or needs_review). Don't duplicate the same term into skills and any
  other category.

- Deduplication: if the same role, credential, or skill term appears more than once anywhere in the
  document (e.g. listed once under "Experience" and again under a separate "Leadership" or
  "Highlights" section), extract it ONCE. Do not create duplicate entries for repeated mentions of
  the same underlying fact.

- NEVER FABRICATE A STRUCTURED ENTRY FROM A HEADER OR A SUMMARY SENTENCE (hard rule — a real,
  confirmed failure mode, not a hypothetical): a structured entry's identifying field (a
  certification's "name", a job's "title", a degree's "institution", etc.) must be a specific line
  that names that exact real-world thing, copied from the text, never synthesized, paraphrased, or
  mutated from a section header or from prose that only DESCRIBES having done something in general
  terms. Example of what NOT to do: a one-line note under "Continuing Education" reading "Completed
  40+ hours of professional-development coursework through an online training provider,
  2023-2024" — with no individual course or credential named anywhere in it — is a narrative
  summary, not a named credential; it must NOT become a certifications entry with an invented name
  like "professional-development coursework." That kind of content goes to "needs_review" only,
  verbatim, untouched. This example is about the total ABSENCE of any individually named item,
  never about specific words like "hours," "coursework," or a provider's name — a real resume
  section using similar-sounding phrasing while ALSO listing individually named credentials (see
  the certifications definition above) is the OPPOSITE case and must be extracted, item by item,
  never folded into needs_review just because the surrounding wording looks similar to this
  example. The same applies to every other category: a section header alone (e.g. "AI &
  Emerging Technology") is not itself an item — if the header has real, specific items listed under
  it, extract those (each is its own real entry); if it doesn't (no items follow it, or it's only
  ever described in summary form), the header and its content go to needs_review together,
  untouched, and no entry is invented to fill the gap. When in doubt whether something is a genuine
  standalone named item or just a description of one, treat it as needs_review — inventing an entry
  is never the safe choice, omitting nothing is.

- "summary" (freeform) = any professional summary / objective / about-me blurb at the top of the
  resume. "hobbies_other" (freeform) = interests, hobbies, and volunteer/community activities ONLY
  — this is NOT a general catch-all. Content that isn't actually a hobby, interest, or volunteer
  activity, and doesn't genuinely fit work_history, education, certifications, or skills, belongs in
  "needs_review" instead, never here. Summary and hobbies/other content must NEVER be placed into
  work_history, education, certifications, or skills, even if it superficially resembles one of
  them.

- "needs_review" (freeform) = the universal catch-all for anything real and visible on the page that
  doesn't genuinely belong in work_history, education, certifications, skills, summary, or
  hobbies_other. This includes — but is not limited to — a role that reads as unpaid employment (see
  the work_history rule above), a clearly-titled section whose content doesn't match any other
  category's definition (e.g. "Career Highlights," "Workplace Strengths," "Achievements," and
  similar), and any content you can't confidently attribute to another category. When genuinely
  unsure which category fits, use needs_review rather than guessing or omitting the content —
  content flagged here is reviewed by a human, not lost.

- Every "freeform" entry must include "heading": the section's own literal heading/label text
  exactly as printed on the page (e.g. "SELECTED CAREER HIGHLIGHTS", "Workplace Strengths"), copied
  verbatim — not reworded, not invented, not guessed. Use an empty string "" only when the content
  genuinely has no visible heading of its own (e.g. an unlabeled continuation of a previous
  section). This is captured for future analysis of what headers actually appear across resumes; it
  does not change how content gets classified.

- Every entry in every category (work_history, education, certifications, freeform) must include
  "position": an integer giving that entry's own reading-order position on the resume, counted
  across ALL categories together (not separately per category) — 0 for whatever comes first reading
  top to bottom, 1 for whatever comes next, and so on, regardless of which category it belongs to.
  This is real document layout, not a ranking: splitting content into separate JSON arrays by
  category already throws away the true order things appeared in (e.g. Skills sitting between a
  Summary and Work History), and "position" is the only thing that lets that real order be
  reconstructed afterward. Also include a top-level "skills_position": an integer with that same
  meaning for where the Skills block itself sits among everything else (or null if there is no
  skills section) — skills are one visual block, not individually positioned entries, so they get
  exactly one position value for the whole block, not one per skill.

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
  work_history: Array<{ company: string; title: string; location?: string; start_date: string; end_date: string; job_responsibilities: string; extraction_confidence: string; position?: number }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; location?: string; start_date: string; end_date: string; extraction_confidence: string; position?: number }>;
  certifications: Array<{ name: string; issuing_body: string; issue_date: string; expiration_date: string; extraction_confidence: string; position?: number }>;
  skills: Array<string>;
  skills_position?: number | null;
  freeform: Array<{ section_type: string; heading: string; content: string; position?: number }>;
};

function isValidExtraction(x: unknown): x is ExtractionResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.work_history) && Array.isArray(o.education) &&
    Array.isArray(o.certifications) && Array.isArray(o.skills) && Array.isArray(o.freeform);
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

      // Item 1 (2026-09-08 regression session): race-window fix, not a guess — reproduced live
      // against two real accounts (jpirone@yahoo.com, john.pirone@gmail.com), both permanently
      // stuck on confirm-resume-data with "no matching row for this candidate" because every one
      // of their work_history_items/etc. rows had candidate_id NULL despite resume_documents'
      // own candidate_id being correctly set. Root cause: `doc.candidate_id` above was read ONCE,
      // before the slow Claude call this function just made — if the candidate confirmed their
      // signup email (triggering confirm-verification's one-time backfill_resume_pipeline_
      // candidate_id RPC) DURING that call, the backfill runs, finds none of these rows to fix yet
      // (they don't exist until the insert below), and sets resume_documents.candidate_id — but
      // this function then inserts using the STALE null it already captured. Nothing ever re-runs
      // that backfill afterward, so the corruption is permanent. Re-reading candidate_id here,
      // immediately before the insert, shrinks that window from several seconds (a real LLM call)
      // to a single fast query — doesn't require doc's other already-fetched fields, so this one
      // extra read is cheap and isolated. See get-resume-extraction's own self-heal for the other
      // half of this fix: repairing accounts already corrupted before this existed.
      const { data: freshDoc } = await supabase
        .from("resume_documents").select("candidate_id").eq("id", resume_document_id).maybeSingle();
      const currentCandidateId = freshDoc?.candidate_id ?? doc.candidate_id;

      const { error: rpcErr } = await supabase.rpc("insert_resume_extraction", {
        p_resume_document_id: resume_document_id,
        p_candidate_id: currentCandidateId,
        p_work_history: parsed.work_history,
        p_education: parsed.education,
        p_certifications: parsed.certifications,
        p_skills: parsed.skills,
        p_skills_position: parsed.skills_position ?? null,
        p_freeform: parsed.freeform,
        // This path only ever runs once real OCR text exists — extraction_status must already be
        // 'ocr_done' to reach here at all (see the check above) — so doc.ocr_raw_text (already
        // fetched) is real, not a guess, and already the exact same text this document's own
        // extraction was performed against. Bug-2 defense-in-depth: see the migration that added
        // certification_source_match for why this is being threaded through now.
        p_ocr_text: doc.ocr_raw_text,
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
          skills: parsed.skills.length,
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
