// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — PDF rasterization building block.
//
// NOT WIRED IN YET. This is real, production-shaped code (not a throwaway spike like
// test-mupdf-render / test-vision-extract, both torn down) — but it isn't called from upload-resume
// or candidate.html. Per explicit instruction, it stays standalone until stress-tested against a
// real, varied batch of PDFs (clean single/multi-page vector, real single/multi-page scanned) and
// those results are reported.
//
// ARCHITECTURE, grounded in tonight's real findings, not assumption:
// - One page per invocation, always — never render every page of a PDF in one call. Confirmed live:
//   opening a real 4-page document with full-resolution embedded photos costs the same ~4-5ms
//   whether the doc has 1 page or 4 (mupdf's open is a cheap structural parse, not an eager decode of
//   every page's image data) — so a caller can safely open a long document just to reach one page.
//   Rendering ALL pages of that same real document in one call, by contrast, genuinely failed with a
//   WORKER_RESOURCE_LIMIT (EDGE_FUNCTION_ERROR) after only 444ms — a real memory ceiling from holding
//   multiple full-resolution decoded bitmaps in one isolate, not a slow CPU-time exhaustion. One page
//   per invocation isn't a defensive guess here, it's the one architecture that's actually survived
//   a real multi-page-real-photo test.
// - mupdf (npm:mupdf, Artifex's official WASM bindings) — deployed and run for real tonight, zero
//   native deps, no Worker/Node-only API dependency (the disqualifying issue that ruled out
//   Tesseract.js in this same investigation). A corrupt/unreadable PDF fails as a normal catchable
//   exception, not an uncatchable kill — a real, meaningful difference from tesseract-wasm's own
//   failure mode, confirmed live with garbage input.
//
// PER-PAGE PRE-CHECK STANDARD (broader than the aspect-ratio-only check upload-resume uses for
// images, per tonight's item 4): every signal below is cheap — available from the PDF's own
// structure or the rendered page, never a separate OCR/vision call just to decide routing.
//   1. Aspect ratio (MediaBox width:height, or the rendered pixel dimensions — same thing at a
//      fixed DPI) — the same >2.0 long:short threshold already proven live for images. Still the
//      strongest single signal for "this looks like a stitched/abnormal composite," now applied to
//      a PDF page's own declared page size rather than a photo's pixel dimensions.
//   2. Page count — free once the document is open (confirmed cheap above): a document with an
//      unusually high page count is flagged even before any page is rendered, independent of which
//      page this particular invocation is asked for.
//   3. Bytes-per-pixel of the rendered PNG (file size ÷ pixel count) — a cheap proxy for "how much
//      visual complexity is on this page" without decoding or OCR-ing anything. Weakest leg of this
//      standard — only a handful of real data points exist so far — kept as a loose, wide band that
//      rarely fires alone, not a hard gate; log it either way so it accumulates real signal over
//      time rather than staying a guess.
// None of these need to be perfect on their own — any one tripping routes the page to vision;
// otherwise it takes the cheaper tesseract-wasm + Haiku path, exactly the pattern upload-resume
// already proved for images.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const BUCKET = "resume-documents";

const ASPECT_RATIO_THRESHOLD = 2.0; // same constant as upload-resume's image-path check
const PAGE_COUNT_THRESHOLD = 15; // loose — a resume this long is itself unusual
// 0.05 was the first guess and it was wrong, caught live tonight: a clean vector-rendered PDF page
// (real text on a real mostly-white background, nothing wrong with it) compressed to ~0.032
// bytes/pixel and got misrouted to vision as "near-blank" — PNG compresses vector text-on-white far
// more efficiently than a photographed page ever does, so the two source types don't share one
// honest threshold. Lowered to stop flagging normal vector pages; still a loose, real-data-backed
// guess, not a tuned constant — the earlier miscalibration is exactly why this whole leg of the
// standard was flagged weakest in tonight's report.
const BYTES_PER_PIXEL_LOW = 0.01; // below this: page reads as near-blank
const BYTES_PER_PIXEL_HIGH = 0.6; // above this: unusually dense/noisy for a rendered page
// Real headroom, not a guess picked in isolation: the four tesseract successes seen tonight
// (a clean vector PDF, single- and multi-page) all rendered at 1275x1650 = 2.10MP and worked
// every time. A real 1555x2200 photographed page failed with WORKER_RESOURCE_LIMIT at every
// render size tried tonight — 14.85MP unclamped, 8.00MP clamped, and 5.00MP clamped — so 5.00MP
// is the smallest confirmed-bad size. Nothing between 2.10MP and 5.00MP has actually been tested.
// 3.0MP sits with real margin on both sides of that gap, biased toward the known-good side since
// a false-positive vision route costs latency, not a crash.
const PIXEL_COUNT_THRESHOLD = 3_000_000;

const VISION_MODEL = "claude-sonnet-5";
const HAIKU_MODEL = "claude-haiku-4-5";

// Identical schema/field-definition contract used by upload-resume's vision fallback and
// extract-resume-fields' Haiku extraction — kept in sync by hand across all three, same as tonight's
// upload-resume change already does relative to extract-resume-fields. Any schema change needs to be
// applied in all three places.
// ZERO-LOSS RULE added after a real, confirmed failure mode (see this session's investigation of
// john.pirone@proton.me's real resume): needs_review's ONLY trigger in the prompt used to be the
// narrow "unpaid role" case, with no general instruction to preserve unclassifiable content at all.
// Reproduced live against the real OCR text: a clearly-headed "CORE COMPETENCIES" section and a
// clearly-headed "SELECTED CAREER HIGHLIGHTS" / first half of "WORKPLACE STRENGTHS" section were
// each silently OMITTED from the model's JSON entirely — not even routed to needs_review — because
// nothing told it to. Separately, hobbies_other's old definition ("...and any other content that
// doesn't fit work history, education, or certifications") was an accidental SECOND catch-all
// competing with needs_review, which is how headerless orphaned content (a continuation bullet, a
// certifications block with no visible issuing header on this page) ended up wrongly dumped into
// hobbies_other instead of needs_review or its real category. The fix below makes needs_review the
// one, explicit, universal fallback and narrows hobbies_other back to what it actually means.
//
// Item 2 (2026-09-08 regression session, distinct from the earlier "AI"/"Al" merge-boundary fix in
// upload-resume's mergeBoundaryContinuations): the NEVER FABRICATE rule's own worked example used
// to read almost word-for-word like a REAL resume's own genuine, itemized certifications list
// ("55+ hours", "AI & emerging technology", a named course provider, "Coursiv") — reproduced live
// against a real 4-page resume ("626") that has exactly that vocabulary in BOTH a genuine bulleted
// list of 8 named credentials under its own "AI & Emerging Technology Certifications" heading AND
// a separate one-line "Continuing Education" narrative mention elsewhere on the page. The model
// folded the entire real list into needs_review, matching the NEVER FABRICATE example's WORDING
// rather than applying the certifications definition's own shape-based carve-out (already present
// from an earlier fix, verified only against a different, easier document) a few lines above it.
// Below: the worked example is now deliberately generic and shares no vocabulary with any real
// resume content, to remove that specific collision, and both rules now explicitly cross-reference
// each other so "the wording looks like the negative example" can't override "this is actually a
// real itemized list" — the distinction was always meant to be about shape, not wording.
const FIELD_DEFINITIONS = `ZERO-LOSS RULE (hard requirement — read this before classifying anything): every visible heading,
paragraph, table, or list on the page must be accounted for somewhere in your output. Never omit
visible content for any reason. Classify it into a real category (work_history, education,
certifications, skills) when it genuinely belongs there; otherwise it goes into "freeform" as
"summary" or "hobbies_other" only when it actually matches one of those two definitions below, and
as "needs_review" for everything else that doesn't fit anywhere — needs_review is the universal
fallback, always available, always correct when nothing else fits. Never force content into a
category it doesn't genuinely belong in just to give it a home.

MULTI-COLUMN TABLE READING ORDER (real, confirmed failure mode — a section laid out as a 2- or
3-column grid of short bullet cells, e.g. "Selected Career Highlights" or similar, got its cells
read in the wrong order and spliced together mid-sentence): when a section's bullets are visually
arranged in a table/grid of columns rather than one single vertical list, read each CELL in full
before moving to the next — complete cell 1's whole sentence, then cell 2's whole sentence, in the
grid's own left-to-right, top-to-bottom reading order (row by row, not column by column, unless the
page's own visual layout clearly reads top-to-bottom within a column first). Never interleave two
different cells' sentences into one merged entry, and never let a word or clause from one cell
bleed into another's. If uncertain which reading order the grid actually uses, prefer keeping each
bullet's own sentence fully intact and separate over guessing at a merged order.

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

- certifications' "license_number" field = the credential's own license, permit, or registration
  number, when the resume actually prints one (e.g. "Lic # CFC1425829", "License No. 12345", "Cert
  #A-9982") — copy it verbatim, including any prefix letters, exactly as printed. This is a SIBLING
  field to "name", never a replacement: "name" stays whatever the resume actually calls the
  credential — a formal title (e.g. "Certified Plumbing Contractor") or an informal trade name
  (e.g. "Plumber") are both real, correct values for "name"; a license number being present is
  never a reason to invent a more formal name than what's printed. Use an empty string "" when no
  license/permit/registration number is printed for that credential — never guess or fabricate one.

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
  the same underlying fact. This also applies ACROSS categories, not just within one: once a
  credential, role, or degree has been captured as its own structured entry (work_history,
  education, or certifications), do not also restate it — by name or by close paraphrase — inside a
  needs_review entry, even if it sits under a section heading that also contains other, genuinely
  uncaptured content. Only the uncaptured remainder of that section (content that doesn't name any
  already-extracted item) belongs in needs_review — a section heading is not dropped just because
  part of its content was already extracted elsewhere, only the part restating an already-extracted
  item is.

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
  example. The same applies to every other category: a section header alone (e.g. "AI & Emerging
  Technology") is not itself an item — if the header has real, specific items listed under it on
  this page, extract those (each is its own real entry); if it doesn't (no items follow it on this
  page, or it's only ever described in summary form), the header and its content go to needs_review
  together, untouched, and no entry is invented to fill the gap. When in doubt whether something is
  a genuine standalone named item or just a description of one, treat it as needs_review —
  inventing an entry is never the safe choice, omitting nothing is.

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
  "position": an integer giving that entry's own reading-order position on THIS page, counted across
  ALL categories together (not separately per category) — 0 for whatever comes first reading top to
  bottom on the page, 1 for whatever comes next, and so on, regardless of which category it belongs
  to. This is real document layout, not a ranking: splitting content into separate JSON arrays by
  category already throws away the true order things appeared in on the page (e.g. Skills sitting
  between a Summary and Work History), and "position" is the only thing that lets that real order be
  reconstructed afterward. Also include a top-level "skills_position": an integer with that same
  meaning for where the Skills block itself sits among everything else on the page (or null if this
  page has no skills section) — skills are one visual block, not individually positioned entries, so
  they get exactly one position value for the whole block, not one per skill. If this page has
  nothing else at all (a single section filling the whole page), position values still start at 0.`;

const SCHEMA_SHAPE = `{
  "work_history": [
    { "company": string, "title": string, "location": string, "start_date": string, "end_date": string,
      "job_responsibilities": string, "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "education": [
    { "institution": string, "degree": string, "field_of_study": string, "location": string,
      "start_date": string, "end_date": string, "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "certifications": [
    { "name": string, "issuing_body": string, "license_number": string, "issue_date": string, "expiration_date": string,
      "extraction_confidence": "high" | "medium" | "low", "position": number }
  ],
  "skills": [ string ],
  "skills_position": number | null,
  "freeform": [
    { "section_type": "summary" | "hobbies_other" | "needs_review", "heading": string, "content": string, "position": number }
  ]
}`;

const DATE_RULES = `DATES: use YYYY-MM-DD when the resume gives a specific day (rare), YYYY-MM-01 when it gives a
month and year, YYYY-01-01 when it gives only a year. If a role/program is current/ongoing
("Present", "Current", no end given), set end_date to an empty string "" — do not invent a real
end date. If a date is entirely absent or unrecoverable, use an empty string "" for that field, not
a guess.

If a category has no entries, return an empty array for it — do not omit the key.`;

// Page-boundary continuation context — real bug, confirmed against a real document (john.pirone's
// resume, 2026-09-07 investigation, priority 3 of a real bug report): every page is extracted by a
// completely independent call with zero knowledge of what came immediately before it. Confirmed
// live, visually, against the actual rendered pages: a certifications bullet list split 9/1 across
// a page boundary landed its 10th item as an orphaned needs_review entry with a self-referential
// heading; a job's last 2 bullets landed on the following page as a headerless orphan; a "WORKPLACE
// STRENGTHS" list split 3/2 across a boundary did the same to its trailing 2 bullets. The
// ZERO-LOSS RULE already stops content from being silently dropped in this situation — it correctly
// routes it to needs_review — but that's not the same as staying attached to the section it's
// actually part of. This context block is the fix: the caller (upload-resume) threads forward a
// short, factual summary of whatever was last on the PREVIOUS page, and this page's own model
// (which can actually see whether ITS content plainly continues that) decides whether to reuse it.
function buildContinuationContext(previousPageContext?: string | null): string {
  if (!previousPageContext) return "";
  return `

CONTEXT FROM THE PREVIOUS PAGE (informational only — you are still extracting ONLY what's visible on
THIS page's image/text; use this only to correctly attribute genuine continuations, never to invent
content that isn't actually here): the previous page ended with ${previousPageContext}
If THIS page's own content plainly begins as a direct continuation of that — e.g. one or more more
bullet points in the same list with the same tone/topic, appearing before any new heading — extract
it using the EXACT SAME heading/company/title given above (copied verbatim, not reworded) rather
than leaving it unlabeled or inventing a new needs_review entry for it. If a certifications list was
still open and this page's first item(s) match that same short "Name (issuer)" pattern with no new
section header first, extract them as normal certifications entries, not freeform. If this page's
opening content is clearly unrelated, or introduces its own new visible heading, treat it as
entirely separate, exactly as you would any other content on the page.`;
}

function buildVisionExtractionPrompt(previousPageContext?: string | null): string {
  return `You are extracting structured data directly from the attached image of one page of a resume. Read the document as printed — do not invent information that is not actually present in the image in some recognizable form. This may be one page of a multi-page resume; only extract what is actually visible on this page.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${SCHEMA_SHAPE}

${FIELD_DEFINITIONS}
  If the resume shows language proficiency as icons, bars, dots, or other non-text graphics rather
  than words, describe what you can determine from the graphic (e.g. the language name and an
  approximate level like "native/fluent/conversational/basic" if the graphic clearly conveys a
  level) in a "summary" or "hobbies_other" freeform entry — do not silently drop it, and do not
  invent a precision level the graphic doesn't actually convey.

${DATE_RULES}${buildContinuationContext(previousPageContext)}`;
}

function buildOcrExtractionPrompt(ocrText: string, previousPageContext?: string | null): string {
  return `You are extracting structured data from the raw OCR text of one page of a resume. The OCR
text below may contain recognition errors (misread characters, words glued together, minor
garbling) — do your best to read through that, but do not invent information that is not actually
present in the text in some recognizable form. This may be one page of a multi-page resume; only
extract what is actually present in this text.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${SCHEMA_SHAPE}

${FIELD_DEFINITIONS}

${DATE_RULES}${buildContinuationContext(previousPageContext)}

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
}

type ExtractionResult = {
  work_history: Array<{ company: string; title: string; location?: string; start_date: string; end_date: string; job_responsibilities: string; extraction_confidence: string; position?: number }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; location?: string; start_date: string; end_date: string; extraction_confidence: string; position?: number }>;
  certifications: Array<{ name: string; issuing_body: string; license_number?: string; issue_date: string; expiration_date: string; extraction_confidence: string; position?: number }>;
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

function extractJsonFromClaudeResponse(claudeData: any): { parsed: unknown; parseError: string | null; rawText: string } {
  // Sonnet 5 (and Haiku 4.5, same family) use adaptive thinking by default — content[0] is often a
  // "thinking" block, not the answer, so find the actual text block rather than assuming index 0.
  const textBlock = (claudeData?.content ?? []).find((b: { type?: string }) => b.type === "text");
  const rawText: string = textBlock?.text ?? "";
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return { parsed: JSON.parse(cleaned), parseError: null, rawText };
  } catch (e) {
    return { parsed: null, parseError: String(e), rawText };
  }
}

async function runVisionExtraction(pngBase64: string, previousPageContext?: string | null): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 16000, // 8192 truncated real runs earlier tonight; 16000 didn't
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
          { type: "text", text: buildVisionExtractionPrompt(previousPageContext) },
        ],
      }],
    }),
  });
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }
  const claudeData = await claudeRes.json();
  const { parsed, parseError, rawText } = extractJsonFromClaudeResponse(claudeData);
  if (parseError) throw new Error(`malformed_vision_response: ${rawText.slice(0, 500)}`);
  if (!isValidExtraction(parsed)) throw new Error("vision_response_wrong_shape");
  return parsed;
}

async function runHaikuExtraction(ocrText: string, previousPageContext?: string | null): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: buildOcrExtractionPrompt(ocrText, previousPageContext) }],
    }),
  });
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }
  const claudeData = await claudeRes.json();
  const { parsed, parseError, rawText } = extractJsonFromClaudeResponse(claudeData);
  if (parseError) throw new Error(`malformed_haiku_response: ${rawText.slice(0, 500)}`);
  if (!isValidExtraction(parsed)) throw new Error("haiku_response_wrong_shape");
  return parsed;
}

// Ported from upload-resume's proven word-clustering OCR reconstruction — kept byte-for-byte
// identical in behavior so tesseract-routed PDF pages get the same real, already-tested pipeline as
// tesseract-routed image uploads, not a second, divergent implementation.
type TextItem = { rect: { left: number; top: number; right: number; bottom: number }; confidence: number; text: string };

// Real, confirmed bug (not theoretical): this column-boundary heuristic used to treat the single
// largest horizontal gap on a page as a column split UNCONDITIONALLY, with no check for whether the
// page is actually two-column at all. On a real production PDF (john.pirone@proton.me's resume,
// page 2 — single-column, flush-left job-title/subheader lines above indented bullets), the gap
// between the base margin and the bullet-indent level became the page's single largest gap and got
// treated as a column boundary, silently splitting "AI Solutions Consultant..." into an isolated
// "AI Solutions" fragment (reordered to the top of the reconstructed text) and "Consultant..." left
// behind — the same mechanism also split "Independent" from "/ Freelance...", "Technical" from
// "Training & Digital Skills...", and "School" from "District of Indian River County...". A second
// real resume (an Enhancv-template PDF with icon-graphic "Strengths"/"Most Proud Of" pairs) showed
// the same mechanism in miniature: a single stray word ("key") isolated by a 17px gap.
//
// MIN_COLUMN_GAP_PX below is set from real, measured word-box gaps, not a guess:
//   - 36px: the actual erroneous gap on the real corrupted page above (measured live via a
//     temporary gap-measurement tool against the real stored document).
//   - 17px: the actual erroneous gap on the second real resume above.
//   - 120px: the actual gap on a real, confirmed genuine two-column resume (the deterministic
//     Taylor-Chen test image proven across test-tesseract-wasm-columns, test-tesseract-wasm-
//     word-columns, and test-real-tesseract-columns) — the real column boundary between its narrow
//     left column and wide right column.
// 60px sits with real headroom on both sides (24px above the largest known-erroneous gap, 60px
// below the one confirmed-genuine gap) — same evidence-based approach as PIXEL_COUNT_THRESHOLD
// above. Below this threshold, the page is treated as single-column: every word stays in one
// reading-order block instead of being split at a gap that's really just margin/indentation.
const MIN_COLUMN_GAP_PX = 60;

function reconstructByWordClustering(words: TextItem[]): string {
  const real = words.filter((w) => w.text.trim().length > 0);
  if (real.length === 0) return "";
  const withLeft = real.map((w) => ({ text: w.text, left: w.rect.left, top: w.rect.top }));
  const sortedLefts = [...withLeft].sort((a, b) => a.left - b.left);
  let maxGap = -1, gapIdx = -1;
  for (let i = 1; i < sortedLefts.length; i++) {
    const gap = sortedLefts[i].left - sortedLefts[i - 1].left;
    if (gap > maxGap) { maxGap = gap; gapIdx = i; }
  }
  // No real column boundary at all if the biggest gap on the page doesn't clear the real-data
  // threshold above — treat the whole page as a single column rather than splitting on what's
  // really just margin or bullet-indent whitespace.
  const boundary = (gapIdx > 0 && maxGap > MIN_COLUMN_GAP_PX) ? (sortedLefts[gapIdx - 1].left + sortedLefts[gapIdx].left) / 2 : Infinity;
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
  return col1Lines.length ? col0Lines.join("\n") + "\n\n" + col1Lines.join("\n") : col0Lines.join("\n");
}

const WASM_URL = "https://cdn.jsdelivr.net/npm/tesseract-wasm@0.11.0/dist/tesseract-core.wasm";
const MODEL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";

async function runTesseract(rgbaBytes: Uint8Array, width: number, height: number): Promise<string> {
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

// Expands 3-byte-per-pixel RGB into 4-byte-per-pixel RGBA (opaque, alpha=255 throughout) in plain
// JS — see the render-block comment above for why this exists instead of asking mupdf for alpha
// directly.
function rgbToRgba(rgb: Uint8Array): Uint8Array {
  const pixelCount = rgb.length / 3;
  const rgba = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { storage_path, page_number, target_dpi, force_vision, previous_page_context } = await req.json();
      if (!storage_path || typeof storage_path !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "storage_path_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const pageNum = Number(page_number) || 1; // 1-indexed
      const dpi = Number(target_dpi) || 150;

      const fetchStart = Date.now();
      const fileRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storage_path}`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!fileRes.ok) {
        return new Response(JSON.stringify({ ok: false, stage: "storage_fetch", error: "storage_fetch_failed", status: fileRes.status }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const pdfBytes = new Uint8Array(await fileRes.arrayBuffer());
      const fetchMs = Date.now() - fetchStart;

      const importStart = Date.now();
      let mupdf: any;
      try {
        mupdf = await import("npm:mupdf@1");
      } catch (importErr) {
        return new Response(JSON.stringify({ ok: false, stage: "import", error: "mupdf_import_failed", detail: String(importErr) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const importMs = Date.now() - importStart;

      const openStart = Date.now();
      let doc: any;
      try {
        doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
      } catch (openErr) {
        return new Response(JSON.stringify({ ok: false, stage: "open", error: "mupdf_open_failed", detail: String(openErr) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const openMs = Date.now() - openStart;

      const pageCount = doc.countPages();
      if (pageNum < 1 || pageNum > pageCount) {
        return new Response(JSON.stringify({ ok: false, error: "page_number_out_of_range", page_count: pageCount }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const page = doc.loadPage(pageNum - 1);
      const bounds = page.getBounds(); // [x0, y0, x1, y1] in PDF points (72/inch)
      const mediaWidth = bounds[2] - bounds[0];
      const mediaHeight = bounds[3] - bounds[1];
      const aspectRatio = Math.max(mediaWidth, mediaHeight) / Math.min(mediaWidth, mediaHeight);

      // MAX_RENDER_PIXELS is a real safety clamp, not a guess: a real embedded-photo page at
      // 1555x2200 native resolution, rendered at the default 150 DPI (2.08x scale), came out to
      // ~14.8 megapixels and genuinely hit WORKER_RESOURCE_LIMIT tonight — a page only ~3x wider
      // than another real page (567x2200, 5.4MP at the same DPI) that rendered fine. DPI-based
      // scaling assumes the PDF's declared page size is in real physical units (points), which is
      // true for a real scan app's output but not guaranteed — a MediaBox already expressed near
      // native pixel resolution (as this session's own test PDFs do, and as some real scan tools
      // may also do) compounds an unwanted extra upscale on top of an already-high-resolution
      // source. Clamping the OUTPUT pixel budget directly, regardless of why a given page would
      // exceed it, is the honest fix: cap the actual render size instead of trusting DPI math to
      // stay reasonable for every source. First attempt used 8 megapixels (between the 5.4MP page
      // that worked and the 14.8MP one that didn't) — still not enough: that same 1555x2200 page,
      // clamped to 8MP, STILL hit WORKER_RESOURCE_LIMIT, just later in the request. Root cause
      // turned out to be downstream, not the render itself: this page's aspect ratio (1.41) and
      // bytes-per-pixel both sit inside normal range, so it routes to tesseract-wasm, not vision —
      // and tesseract-wasm's own memory use scales with image size on top of whatever the render
      // step already used. The proven-working image-upload path never faces this because the
      // client caps photos to 2200px on the long edge BEFORE tesseract ever sees them (≤4.84MP
      // for a square image, less for anything narrower) — 5 megapixels here sits just above that
      // real, already-proven ceiling rather than a fresh guess.
      const MAX_RENDER_PIXELS = 5_000_000;
      let scale = dpi / 72;
      const estimatedPixels = mediaWidth * scale * (mediaHeight * scale);
      if (estimatedPixels > MAX_RENDER_PIXELS) {
        scale *= Math.sqrt(MAX_RENDER_PIXELS / estimatedPixels);
      }
      const matrix = mupdf.Matrix.scale(scale, scale);

      // SEPARATE real finding, different from the MAX_RENDER_PIXELS story above (2026-09-06,
      // investigating a real production WORKER_RESOURCE_LIMIT on john.pirone@proton.me's resume):
      // this clamp assumes the failure predicts from THIS page's own size. It doesn't, always.
      // Confirmed live: all 4 pages of that real resume share the identical MediaBox (612x792 —
      // ordinary US Letter), and at the default 150 DPI every page's estimated pixel count
      // (~2.1MP) sits comfortably under this 5MP clamp — it never engages, correctly, because
      // this page was never oversized. Yet two of those four pages (not always the same two)
      // genuinely hit WORKER_RESOURCE_LIMIT in real, reproducible testing, while the other two
      // succeeded — on identical content, identical code, identical DPI. Reproduced deliberately
      // by firing 8 real concurrent requests at this same document: 3/8 failed this way, spread
      // across every page number, no page-specific pattern. This is concurrent load on the
      // platform's shared worker pool competing for the SAME aggregate memory/CPU budget this
      // invocation needs — not a property this function can measure about its own page at all.
      // Nothing here can fix that: there is no version of this clamp, tuned to any threshold,
      // that would distinguish "this exact page, right now" from "this exact page, five minutes
      // from now with less contention." The real fix lives in the caller (upload-resume): retry
      // the same page as a fresh, separate invocation — a different real worker, unaffected by
      // whatever killed this one — first at a lower DPI, then with force_vision if that also
      // fails (both real, measured to reduce but not eliminate the failure rate under the same
      // concurrent load — retrying is a mitigation against a real platform ceiling, not a
      // guarantee). See upload-resume's own header for the retry contract this function's
      // target_dpi/force_vision params exist to serve.

      // alpha=false, always — a third real finding tonight: mupdf's own alpha=true render path
      // throws a genuine "RangeError: offset is out of bounds" on the hand-built vector-text PDFs,
      // and moving WHERE that call happened (primary render vs. a second tesseract-only render)
      // didn't help, because the bug lives inside mupdf's alpha-compositing path itself, not in
      // how/when this code calls it. Also real: alpha=true costs measurably more memory (4
      // bytes/pixel vs 3) — a single real embedded-photo page alone hit WORKER_RESOURCE_LIMIT at
      // alpha=true where the same page had not failed without it. So alpha=true is avoided
      // entirely now, on every path, for both reasons. tesseract-wasm still needs RGBA — that
      // conversion happens in plain JS below (rgbToRgba), a trivial per-pixel byte-array expansion
      // that sidesteps mupdf's alpha path altogether rather than fighting it further.
      const renderStart = Date.now();
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const pngBytes = pixmap.asPNG();
      const renderMs = Date.now() - renderStart;

      const renderedWidth = pixmap.getWidth();
      const renderedHeight = pixmap.getHeight();
      const bytesPerPixel = pngBytes.length / (renderedWidth * renderedHeight);
      const totalPixels = renderedWidth * renderedHeight;

      // --- Per-page pre-check standard (item 4) ---
      const reasons: string[] = [];
      if (aspectRatio > ASPECT_RATIO_THRESHOLD) reasons.push(`aspect_ratio ${aspectRatio.toFixed(2)} > ${ASPECT_RATIO_THRESHOLD}`);
      if (pageCount > PAGE_COUNT_THRESHOLD) reasons.push(`page_count ${pageCount} > ${PAGE_COUNT_THRESHOLD}`);
      if (bytesPerPixel < BYTES_PER_PIXEL_LOW) reasons.push(`bytes_per_pixel ${bytesPerPixel.toFixed(3)} < ${BYTES_PER_PIXEL_LOW} (near-blank)`);
      if (bytesPerPixel > BYTES_PER_PIXEL_HIGH) reasons.push(`bytes_per_pixel ${bytesPerPixel.toFixed(3)} > ${BYTES_PER_PIXEL_HIGH} (unusually dense)`);
      if (totalPixels > PIXEL_COUNT_THRESHOLD) reasons.push(`total_pixels ${(totalPixels / 1e6).toFixed(2)}MP > ${(PIXEL_COUNT_THRESHOLD / 1e6).toFixed(1)}MP`);
      // force_vision: an explicit caller override, not a signal this function measured itself.
      // Real, confirmed need (this session's WORKER_RESOURCE_LIMIT investigation): none of the
      // signals above predict that failure — it's real, reproduced-live concurrent-load
      // contention on the platform's shared worker pool, not a property of this page's content,
      // and it hit pages whose own aspect_ratio/page_count/bytes_per_pixel/total_pixels were all
      // completely ordinary (confirmed live: identical MediaBox to a page that never failed).
      // Nothing measurable about a page predicts this, so upload-resume's retry loop (see that
      // function's header) sets this directly on its last retry, after two real failures already
      // happened, to route around tesseract-wasm's own real, heavier WASM memory footprint —
      // never inferred here.
      if (force_vision) reasons.push("force_vision requested by caller");
      const useVision = reasons.length > 0;

      let extraction: ExtractionResult;
      let extractionMs: number;
      let ocrText: string | undefined;
      let ocrMs: number | undefined;

      if (useVision) {
        const visionStart = Date.now();
        extraction = await runVisionExtraction(bytesToB64(pngBytes), previous_page_context);
        extractionMs = Date.now() - visionStart;
      } else {
        const ocrStart = Date.now();
        const rgb = pixmap.getPixels(); // raw RGB Uint8Array (3 bytes/pixel) — no alpha, per above
        const rgba = rgbToRgba(rgb);
        ocrText = await runTesseract(rgba, renderedWidth, renderedHeight);
        ocrMs = Date.now() - ocrStart;
        const haikuStart = Date.now();
        extraction = await runHaikuExtraction(ocrText, previous_page_context);
        extractionMs = Date.now() - haikuStart;
      }

      return new Response(JSON.stringify({
        ok: true,
        storage_path,
        page: pageNum,
        page_count: pageCount,
        media_box: { width: mediaWidth, height: mediaHeight },
        aspect_ratio: aspectRatio,
        render: {
          requested_dpi: dpi,
          effective_scale: scale,
          clamped: scale !== dpi / 72,
          width_px: renderedWidth,
          height_px: renderedHeight,
          png_bytes: pngBytes.length,
          bytes_per_pixel: bytesPerPixel,
        },
        routing: { method: useVision ? "vision" : "tesseract", reasons },
        extraction,
        ocr_raw_text: ocrText,
        timing_ms: { fetch: fetchMs, import: importMs, open: openMs, render: renderMs, ocr: ocrMs, extraction: extractionMs },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
