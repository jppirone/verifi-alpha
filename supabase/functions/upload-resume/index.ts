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
// PDF SUPPORT (added after real stress-testing — 7/7 real PDFs across 4 real document shapes,
// same session as rasterize-pdf-page itself): the earlier "alpha accepts image uploads only" scope
// decision is retired. PDF rasterization inside an Edge Function was the real unsolved problem
// blocking it (same shape as the Tesseract-in-Deno problem this session fought through for images);
// it's solved now, in rasterize-pdf-page, one page per invocation (a real memory-ceiling finding,
// not a guess — see that function's header). PDFs skip the client-side canvas decode entirely
// (there's no canvas decode for a PDF) and go through the PDF branch below instead, which calls
// rasterize-pdf-page once per page and merges the per-page structured extractions.
//
// Word/.docx stays out of scope deliberately — a separate infrastructure/vendor decision, not a
// technical gap like PDF was. Flat pre-stitched multi-page images (a candidate manually combining
// several page-photos into one file) are also NOT supported: that heuristic was tested for real
// against the actual motivating file and killed (see STITCHED_ASPECT_RATIO_THRESHOLD below — it
// still exists to catch and vision-route a stitch that slips through, not to make stitching a
// supported path). A candidate with a multi-page photographed resume is expected to upload a real
// PDF or one image per page, not a manual stitch.
const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/pdf",
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
//
// Item 2 (2026-09-08 regression session): certifications carve-out + de-collided NEVER FABRICATE
// example below, mirroring the same fix in rasterize-pdf-page/index.ts and extract-resume-fields/
// index.ts (rasterize-pdf-page's own header has the full story). This copy was missing the
// carve-out entirely before this fix — kept in sync now so the same misclassification can't
// resurface via this specific fallback path (stitched/oversized single images) either, even
// though it wasn't the path that actually reproduced the bug.
const VISION_EXTRACTION_PROMPT = `You are extracting structured data directly from the attached image of a resume. Read the document as printed — do not invent information that is not actually present in the image in some recognizable form.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
  "candidate_location": string,
  "printed_header": string,
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
}

ZERO-LOSS RULE (hard requirement — read this before classifying anything): every visible heading,
paragraph, table, or list on the page must be accounted for somewhere in your output. Never omit
visible content for any reason. Classify it into a real category (work_history, education,
certifications, skills) when it genuinely belongs there; otherwise it goes into "freeform" as
"summary" or "hobbies_other" only when it actually matches one of those two definitions below, and
as "needs_review" for everything else that doesn't fit anywhere — needs_review is the universal
fallback, always available, always correct when nothing else fits. Never force content into a
category it doesn't genuinely belong in just to give it a home.

HEADINGS ARE A HELPFUL SIGNAL, NEVER A REQUIREMENT (a real, confirmed failure mode — a plain,
minimally-formatted document with no section headings at all, no bold text, no visual separation
whatsoever, still has real work history, education, and certifications on it, and they must still
be extracted into their real structured categories, not dumped into needs_review just because
nothing labels them): classify content by what it actually IS — its own inherent shape and
content pattern — never by whether a labeled heading or bold/visual styling happens to precede
it. A line naming a trade or credential followed by a license/certification/registration number
(e.g. "Plumber" then "Lic # CFC1425829", "License No. 12345", "Cert #A-9982") is a certifications
entry regardless of whether any heading like "Certifications" appears above it anywhere on the
page — the credential-name-plus-license-number pattern IS the classification signal, the same way
a company+title+date-range pattern identifies work_history and a degree+institution pattern
identifies education, with or without a labeled section heading present. Never let the mere
absence of a heading push content that otherwise clearly fits a real category into needs_review —
that catch-all is for content that genuinely doesn't fit any category, not for content that fits
one perfectly but happens to lack a visible label.

FIELD AND CATEGORY DEFINITIONS — read carefully, these are not interchangeable buckets:

- "candidate_location" (top-level, not inside any category) = the candidate's OWN personal
  location, as printed near their name/contact line at the top of the resume (e.g. "Sebastian FL",
  "Austin, TX") — copy it verbatim, in whatever form it's printed. This is NOT the same field as
  work_history's or education's own "location" (an employer's or institution's location) — never
  confuse the two, and never copy an employer/institution location into this field just because the
  candidate's own location wasn't printed. Use an empty string "" when no personal location is
  printed anywhere on the page — never infer or guess one.

- "printed_header" (top-level, not inside any category) = the ENTIRE personal-info header block
  exactly as printed at the top of the resume — the candidate's own name (including any middle
  initial, suffix like "Jr." or "Sr.", or professional qualifier like "Esq." or "PE", exactly as
  printed, in whatever order and case it appears), plus every contact/location line printed
  alongside it (phone, email, mailing address, city/state, LinkedIn URL, etc.). Captured as ONE
  literal block of text — never parsed into separate name/phone/email/location parts, unlike
  candidate_location above, which stays a separate, structured field for exactly the location
  piece. Preserve the resume's own line breaks using "\n" between them; copy every character
  verbatim, including capitalization and punctuation — never reformat, reorder, translate, or
  normalize anything, and never add or drop words. Use an empty string "" only if the resume
  genuinely has no such header block at all (e.g. a bare list of qualifications with no name or
  contact line anywhere) — never invent or reconstruct one.

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
  candidate_location?: string;
  printed_header?: string;
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
// the same mechanism in miniature: a single stray word ("key") isolated by a 17px gap. The old
// comment on this function claimed col1 would reliably come back empty for a "genuinely single-
// column" resume — that was never actually true; col1 ends up empty only when the biggest gap on
// the page happens to fall at the very end of the sorted left-x list, not whenever the page is
// single-column, which is exactly how these fragments slipped through unnoticed.
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
// below the one confirmed-genuine gap) — same evidence-based approach as rasterize-pdf-page's
// PIXEL_COUNT_THRESHOLD. Below this threshold, the page is treated as single-column: every word
// stays in one reading-order block instead of being split at a gap that's really just margin or
// bullet-indent whitespace.
const MIN_COLUMN_GAP_PX = 60;

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
  // col1 is now reliably empty whenever no gap on the page cleared MIN_COLUMN_GAP_PX above (boundary
  // is Infinity in that case, so every word lands in col0) — don't glue a spurious blank second
  // block onto genuinely single-column resumes.
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

// Server-to-server call to the sibling function — same project, so the internal functions URL
// works directly. Real gap found live: rasterize-pdf-page's OWN code is auth:"none" (its
// withSupabase wrapper doesn't require a JWT), but the Supabase platform's own gateway enforces
// JWT verification in front of every function regardless of what the function's code says —
// confirmed by a real 502 "Missing authorization header" on the first real end-to-end test of this
// wiring. The service-role key (already available here) satisfies that gateway check.
const RASTERIZE_FN_URL = `${SUPABASE_URL}/functions/v1/rasterize-pdf-page`;

// Real safety valve on the page LOOP itself, distinct from rasterize-pdf-page's own
// PAGE_COUNT_THRESHOLD=15 (which only affects that function's per-page tesseract-vs-vision
// routing, not how many pages get requested). A resume is practically 1-3 pages; this just stops a
// pathological upload from making this function issue dozens of sequential per-page calls. Not
// real-data-calibrated — no test tonight exercised more than 3 pages — flagged as a guess like
// every other untested boundary in this pipeline.
const MAX_PDF_PAGES = 30;

// RASTERIZE RETRY CONTRACT — real finding, 2026-09-06 (investigating a real production
// WORKER_RESOURCE_LIMIT on john.pirone@proton.me's resume, pages that render normally most of the
// time): confirmed live that this failure is NOT predictable from a page's own MediaBox or
// content — all 4 pages of that real resume share identical page size, and at default DPI the
// SAME page fails or succeeds depending only on how much OTHER concurrent load is hitting the
// platform's shared worker pool at that moment (reproduced directly: firing 8 real concurrent
// rasterize-pdf-page calls at that document made 3/8 fail this way, spread across every page
// number, no page-specific pattern). Confirmed via the real response itself that this is an
// UNCATCHABLE isolate kill, not a normal exception: the failure response carries Supabase's own
// platform-gateway headers (x-served-by: supabase-edge-runtime, sb-error-code) and a bare
// {code,message} body that doesn't match ANY shape rasterize-pdf-page's own code ever returns
// (compare: a genuinely corrupt PDF returns THIS function's own {ok:false,error:"mupdf_open_failed",
// ...} shape with this function's own CORS headers — a real, normal, catchable exception, a
// categorically different failure) — meaning rasterize-pdf-page's own top-level try/catch never
// ran; there is no "catch and retry" possible from inside that one invocation. What IS real and
// catchable is this: from OUT HERE, one dead invocation is just an ordinary HTTP response (status
// 546) to whatever called it — a completely separate request/isolate boundary a retry from this
// side isn't bound by. So retrying lives here, not there. Also confirmed live, and important:
// retrying at a lower DPI reduces but does NOT eliminate the failure rate under the same real
// concurrent load (8 concurrent calls at 110 DPI against the same document: 2/8 still failed the
// same way) — so a single DPI-down retry is a real mitigation, not a guarantee, which is exactly
// why there's a second, different retry below rather than stopping at one.
const RESOURCE_LIMIT_CODE = "WORKER_RESOURCE_LIMIT";
// Real value already proven this session (the manual workaround used to test this exact
// document before this retry existed) — half the default's pixel count, comfortably legible,
// meaningfully cheaper for both mupdf's render and tesseract-wasm's own memory use.
const RASTERIZE_RETRY_DPI = 110;

type RasterizePageResult = {
  ok: boolean;
  data: { ok?: boolean; page_count?: number; extraction?: unknown; code?: string; error?: string; message?: string };
  status: number;
};

async function callRasterizePage(storagePath: string, pageNumber: number, opts?: { targetDpi?: number; forceVision?: boolean; previousPageContext?: string }): Promise<RasterizePageResult> {
  const body: Record<string, unknown> = { storage_path: storagePath, page_number: pageNumber };
  if (opts?.targetDpi) body.target_dpi = opts.targetDpi;
  if (opts?.forceVision) body.force_vision = true;
  if (opts?.previousPageContext) body.previous_page_context = opts.previousPageContext;
  const res = await fetch(RASTERIZE_FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, status: res.status };
}

// Three real attempts, each a fresh separate invocation (see the contract comment above for why
// that matters): default DPI first — unchanged behavior/quality for the common case, which is
// most of the time, real data confirmed (most concurrent-load test calls still succeeded even
// under deliberately heavy contention). Only on the SPECIFIC confirmed WORKER_RESOURCE_LIMIT
// signature does this retry at all — a real, different failure (corrupt PDF, bad storage path,
// out-of-range page) is a permanent failure no retry would fix, and gets reported immediately,
// same as before this existed. Retry 1 drops to RASTERIZE_RETRY_DPI (real, measured mitigation,
// not a guarantee). Retry 2 adds force_vision on top — routes around tesseract-wasm's own real,
// heavier WASM memory use entirely rather than just shrinking what it has to process, the
// strongest lever actually available against a resource ceiling neither this page's content nor
// its own request can predict or control.
async function rasterizePageWithRetry(storagePath: string, pageNumber: number, previousPageContext?: string): Promise<RasterizePageResult> {
  const attempt1 = await callRasterizePage(storagePath, pageNumber, { previousPageContext });
  if (attempt1.data?.code !== RESOURCE_LIMIT_CODE) return attempt1;
  console.log(`upload-resume: page ${pageNumber} hit ${RESOURCE_LIMIT_CODE} at default DPI, retrying at ${RASTERIZE_RETRY_DPI} DPI`);

  const attempt2 = await callRasterizePage(storagePath, pageNumber, { targetDpi: RASTERIZE_RETRY_DPI, previousPageContext });
  if (attempt2.data?.code !== RESOURCE_LIMIT_CODE) return attempt2;
  console.log(`upload-resume: page ${pageNumber} hit ${RESOURCE_LIMIT_CODE} again at ${RASTERIZE_RETRY_DPI} DPI, retrying with force_vision`);

  return await callRasterizePage(storagePath, pageNumber, { targetDpi: RASTERIZE_RETRY_DPI, forceVision: true, previousPageContext });
}

// Merges N per-page ExtractionResult objects (one per rasterize-pdf-page call) into one. Plain
// concatenation, no cross-page dedup — a role or credential that legitimately repeats verbatim
// across two pages of the same resume is rare, and rasterize-pdf-page's own prompt already dedups
// WITHIN a single page. Real, known gap for the rare cross-page duplicate; not solved here.
//
// POSITION GLOBALIZATION: the model only ever sees one page at a time (see the migration's own
// header for why — rendering multiple pages in one call is a real, reproduced memory-ceiling
// failure, not a stylistic choice), so every "position" value it returns is local to that one page
// (0, 1, 2... in that page's own reading order). This is the one place with enough context to turn
// those into real, globally-ordered positions: pages are requested and pushed in strict page-number
// order already (the caller's own for-loop), so multiplying each page's own number into its
// positions before concatenating preserves both cross-page order (page 1's items always sort before
// page 2's) and within-page order (untouched, just offset). PAGE_POSITION_SPAN (1000) is a generous
// per-page headroom — no real resume page has come anywhere close to 1000 distinct extracted units
// — chosen the same way MAX_PDF_PAGES was: a safety margin, not a tuned constant.
const PAGE_POSITION_SPAN = 1000;

function globalizePosition(pageNumber: number, localPosition: number | undefined | null): number | null {
  if (typeof localPosition !== "number" || !Number.isFinite(localPosition)) return null;
  return pageNumber * PAGE_POSITION_SPAN + localPosition;
}

// Real page-boundary corruption, confirmed live against a real document (john.pirone's resume,
// 2026-09-07 investigation) by rendering all 4 pages and reading them directly, not guessed from
// position numbers alone: a certifications bullet list split 9/1 across a page boundary, a job's
// last 2 bullets left on the following page, and a "WORKPLACE STRENGTHS" list split 3/2 across a
// boundary all lost their section attribution on the later page — each page is extracted by a
// completely independent model call (see rasterize-pdf-page's own per-page prompt) with zero
// knowledge of what was still open at the end of the previous one.
//
// describeTrailingItem is half the fix: after each page's OWN extraction, this summarizes whatever
// was position-last on THAT page (the most plausible thing a following page might continue), so it
// can be threaded into the NEXT page's rasterize-pdf-page call as previous_page_context — see that
// function's own buildContinuationContext for how it's used. Deliberately excludes education: a
// degree entry is one complete fact, not an open-ended list a following page would plausibly
// continue, so including it would just be noise the model has to read past.
function describeTrailingItem(extraction: ExtractionResult): string | undefined {
  type Candidate = { position: number; describe: () => string };
  const candidates: Candidate[] = [];
  for (const w of extraction.work_history) {
    if (typeof w.position !== "number") continue;
    candidates.push({
      position: w.position,
      describe: () => `a work-history entry at "${w.company || "(unnamed company)"}" as "${w.title || "(unnamed title)"}", whose visible responsibilities on that page ended with: "...${(w.job_responsibilities || "").slice(-220)}"`,
    });
  }
  for (const c of extraction.certifications) {
    if (typeof c.position !== "number") continue;
    candidates.push({
      position: c.position,
      describe: () => `a certifications list, whose last visible entry on that page was "${c.name || "(unnamed)"}"${c.issuing_body ? ` (${c.issuing_body})` : ""}`,
    });
  }
  for (const f of extraction.freeform) {
    if (typeof f.position !== "number") continue;
    candidates.push({
      position: f.position,
      describe: () => `a freeform section${f.heading ? ` titled "${f.heading}"` : " with no visible heading"} (type: ${f.section_type}), whose visible content on that page ended with: "...${(f.content || "").slice(-220)}"`,
    });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.position - a.position);
  return candidates[0].describe();
}

// The other half of the fix: even when the previous-page context above works exactly as intended,
// the result is still two separate rows (one per page) until something recombines them. This finds
// page-adjacent pairs — the last item globalized onto page N and the first item globalized onto
// page N+1 — that share the same heading (freeform) or the same company+title (work_history), and
// merges them into one row. Deliberately conservative: only merges on an EXACT match (normalized
// for case/whitespace only) across NUMERICALLY ADJACENT pages, never a fuzzy guess. A genuinely new
// section that happens to reuse a heading elsewhere in the document is a same-content-different-
// pages case the prompt's own dedup rule already owns — not this function's job, and not something
// this would touch anyway (the page-adjacency check alone rules out anything not a boundary case).
// Certifications are deliberately NOT handled here — a continuation certification, once correctly
// classified via the context hint, is already a normal, independent entry needing no merge.
function mergeBoundaryContinuations(extraction: ExtractionResult): ExtractionResult {
  const pageOf = (pos: number | undefined) => (typeof pos === "number" ? Math.floor(pos / PAGE_POSITION_SPAN) : null);
  // Severity 1 (2026-09-08 regression session, item 4/5 investigation): reproduced live against
  // the real document this whole merge logic was built against — the SAME heading
  // ("AI & EMERGING TECHNOLOGY CERTIFICATIONS...") came back as "AI" from one page's vision call
  // and "Al" (capital A, lowercase L) from the other, a real font-rendering ambiguity between
  // capital I and lowercase l that vision models genuinely mis-transcribe — and plain
  // .toLowerCase() doesn't fix it: "ai" vs "al" are still different strings. That silently broke
  // this exact merge (the 9-item certifications list stayed split across the page boundary,
  // compounding the separate certifications-classification gap investigated the same session).
  // Folding lowercase "l" to "i" before comparing is a targeted, heading-comparison-only fix for
  // this specific, confirmed ambiguity — not a general text-normalization change, and scoped to
  // exact whole-heading equality, so it can't cause a false merge between two otherwise-different
  // headings the way a substring or fuzzy match could.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/l/g, "i");

  const freeform = [...extraction.freeform].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const mergedFreeform: typeof freeform = [];
  for (const item of freeform) {
    const prev = mergedFreeform[mergedFreeform.length - 1];
    const prevPage = pageOf(prev?.position);
    const itemPage = pageOf(item.position);
    if (
      prev && prevPage !== null && itemPage !== null && itemPage === prevPage + 1 &&
      prev.heading && item.heading && norm(prev.heading) === norm(item.heading)
    ) {
      prev.content = `${prev.content}\n\n${item.content}`.trim();
      continue;
    }
    mergedFreeform.push({ ...item });
  }

  const workHistory = [...extraction.work_history].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const mergedWorkHistory: typeof workHistory = [];
  for (const item of workHistory) {
    const prev = mergedWorkHistory[mergedWorkHistory.length - 1];
    const prevPage = pageOf(prev?.position);
    const itemPage = pageOf(item.position);
    if (
      prev && prevPage !== null && itemPage !== null && itemPage === prevPage + 1 &&
      prev.company && item.company && norm(prev.company) === norm(item.company) &&
      prev.title && item.title && norm(prev.title) === norm(item.title)
    ) {
      prev.job_responsibilities = `${prev.job_responsibilities}\n\n${item.job_responsibilities}`.trim();
      continue;
    }
    mergedWorkHistory.push({ ...item });
  }

  return { ...extraction, freeform: mergedFreeform, work_history: mergedWorkHistory };
}

function mergeExtractions(pages: Array<{ pageNumber: number; extraction: ExtractionResult }>): ExtractionResult {
  const merged = {
    // Item 19 (2026-09-12 live-testing session): same "first page that actually reported one"
    // pattern as skills_position just below — a candidate's own personal location, printed once
    // near their name/contact line, only ever realistically appears on page 1, but this doesn't
    // hard-code that assumption.
    candidate_location: (() => {
      const withLocation = pages.find(({ extraction }) => !!extraction.candidate_location);
      return withLocation ? withLocation.extraction.candidate_location : "";
    })(),
    // Item 6 (2026-09-12 live-testing session, follow-up build): same "first page that actually
    // reported one" pattern as candidate_location just above — the printed header block only ever
    // realistically appears on page 1, but this doesn't hard-code that assumption either.
    printed_header: (() => {
      const withHeader = pages.find(({ extraction }) => !!extraction.printed_header);
      return withHeader ? withHeader.extraction.printed_header : "";
    })(),
    work_history: pages.flatMap(({ pageNumber, extraction }) =>
      extraction.work_history.map((w) => ({ ...w, position: globalizePosition(pageNumber, w.position) ?? undefined }))),
    education: pages.flatMap(({ pageNumber, extraction }) =>
      extraction.education.map((e) => ({ ...e, position: globalizePosition(pageNumber, e.position) ?? undefined }))),
    certifications: pages.flatMap(({ pageNumber, extraction }) =>
      extraction.certifications.map((c) => ({ ...c, position: globalizePosition(pageNumber, c.position) ?? undefined }))),
    skills: pages.flatMap(({ extraction }) => extraction.skills),
    // Only one page can sensibly claim "the" skills block position — the first page that actually
    // reported one. A resume with skills split oddly across pages is a real edge case this doesn't
    // try to solve; it just doesn't crash or silently pick an arbitrary later page instead.
    skills_position: (() => {
      const withSkills = pages.find(({ extraction }) => typeof extraction.skills_position === "number");
      return withSkills ? globalizePosition(withSkills.pageNumber, withSkills.extraction.skills_position) : null;
    })(),
    freeform: pages.flatMap(({ pageNumber, extraction }) =>
      extraction.freeform.map((f) => ({ ...f, position: globalizePosition(pageNumber, f.position) ?? undefined }))),
  };
  return mergeBoundaryContinuations(merged);
}

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
      const isPdf = mime_type === "application/pdf";
      // PDFs skip the client canvas-decode entirely (there's no canvas decode for a PDF) — only
      // the raw file bytes are required. Images still need the full client-decoded set.
      if (!original_base64 || (!isPdf && (!sanitized_base64 || !rgba_base64 || !width || !height))) {
        return new Response(JSON.stringify({
          ok: false,
          error: "missing_upload_data",
          message: "Upload was incomplete (this browser may not support processing this file). Try a JPEG, PNG, or PDF.",
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
      // No sanitized render for a PDF — sanitizing means "flattened/EXIF-stripped image", and a
      // multi-page PDF has no single image to flatten to. rasterize-pdf-page reads originalPath
      // directly, page by page, instead.
      const sanitizedPath = isPdf ? null : `${linkValue}/${docId}/sanitized.jpg`;

      const originalBytes = base64ToBytes(original_base64);

      const uploads = [supabase.storage.from(BUCKET).upload(originalPath, originalBytes, { contentType: mime_type, upsert: false })];
      if (!isPdf) {
        const sanitizedBytes = base64ToBytes(sanitized_base64);
        uploads.push(supabase.storage.from(BUCKET).upload(sanitizedPath!, sanitizedBytes, { contentType: "image/jpeg", upsert: false }));
      }
      const [origUpload, sanUpload] = await Promise.all(uploads);
      if (origUpload.error || sanUpload?.error) {
        return new Response(JSON.stringify({
          ok: false, error: "storage_upload_failed",
          detail: { original: origUpload.error?.message, sanitized: sanUpload?.error?.message },
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

      // PDF branch: one page per rasterize-pdf-page call, per the real memory-ceiling finding that
      // function's header documents (rendering every page in one invocation genuinely fails with
      // WORKER_RESOURCE_LIMIT — not a guess, a reproduced failure). Page 1's response carries
      // page_count, so it's called first and the rest follow in a loop. Each call goes through
      // rasterizePageWithRetry (see the RASTERIZE RETRY CONTRACT comment above MAX_PDF_PAGES) —
      // a real, separate finding from the one above: even an ordinary, correctly-sized page can
      // hit the same WORKER_RESOURCE_LIMIT from real concurrent load this function can't predict
      // or avoid on the first attempt, only recover from on a fresh one. Each successful call
      // already returns a complete, routed (tesseract-vs-vision) structured extraction for that
      // one page — this function's own OCR/vision logic below is for the image path only and
      // isn't reused here. Same short-circuit as the image vision-fallback branch: goes straight
      // to 'extracted', skipping 'ocr_done' and extract-resume-fields' separate Haiku call, since
      // every page already comes back fully extracted.
      if (isPdf) {
        console.log(`upload-resume: ${docId} is a PDF, routing through rasterize-pdf-page`);
        const pageExtractions: Array<{ pageNumber: number; extraction: ExtractionResult }> = [];
        // Real gap this closes (2026-09-07, bug-2 defense-in-depth investigation): rasterize-pdf-page
        // returns ocr_raw_text in its own per-page response, but nothing here ever read it — the
        // only thing pulled off pageData was `.extraction`. For a multi-page PDF (the real, common
        // case — this is exactly the document that surfaced bug 2), that meant no OCR text existed
        // ANYWHERE in the database once extraction finished, confirmed directly against the deployed
        // code before writing this. Collected here, per page, in page order; joined with a page
        // marker (not just concatenated blind) so a human or a future tool can still tell where a
        // given stretch of text came from. A vision-routed page contributes nothing here (there is
        // no OCR step for vision, by architecture, not an oversight) — its marker is still emitted so
        // the gap in coverage is visible in the stored text itself, not silently absent.
        const pageOcrTexts: string[] = [];
        let pageCount = 1;
        // Page-boundary continuation context (2026-09-07, priority-3 investigation — see
        // describeTrailingItem's own header for the full story): pages are already requested
        // strictly in order in this loop, one full round-trip at a time, so this is simply "what did
        // the page we just finished end with" carried into the next call. undefined on page 1 (there
        // is no previous page) — buildContinuationContext treats that as "say nothing," unchanged
        // prompt behavior for a single-page resume or the first page of any resume.
        let previousPageContext: string | undefined;
        for (let pageNumber = 1; pageNumber <= pageCount && pageNumber <= MAX_PDF_PAGES; pageNumber++) {
          let pageData: { ok?: boolean; page_count?: number; extraction?: unknown; ocr_raw_text?: string; code?: string; error?: string; message?: string };
          let pageOk: boolean;
          try {
            const result = await rasterizePageWithRetry(originalPath, pageNumber, previousPageContext);
            pageOk = result.ok;
            pageData = result.data;
          } catch (fetchErr) {
            await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
            return new Response(JSON.stringify({
              ok: false, error: "pdf_rasterize_unreachable", detail: String(fetchErr),
              resume_document_id: docId, page: pageNumber,
            }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          if (!pageOk || !pageData.ok || !isValidExtraction(pageData.extraction)) {
            await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
            const stillResourceLimited = pageData.code === RESOURCE_LIMIT_CODE;
            return new Response(JSON.stringify({
              ok: false,
              error: stillResourceLimited ? "pdf_page_extraction_failed_after_retries" : "pdf_page_extraction_failed",
              detail: pageData.message || pageData.error || pageData.code || "unknown_error",
              resume_document_id: docId, page: pageNumber,
            }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          pageExtractions.push({ pageNumber, extraction: pageData.extraction });
          pageOcrTexts.push(`--- page ${pageNumber} ---\n` + (pageData.ocr_raw_text ?? "(vision-routed page, no OCR text)"));
          previousPageContext = describeTrailingItem(pageData.extraction);
          if (pageNumber === 1 && typeof pageData.page_count === "number" && pageData.page_count > 0) {
            pageCount = pageData.page_count;
          }
        }

        const merged = mergeExtractions(pageExtractions);
        const combinedOcrText = pageOcrTexts.join("\n\n");
        // Item 1 (2026-09-08 regression session): race-window fix — see extract-resume-fields' own
        // header for the full mechanism, reproduced live against two real accounts. docRow.candidate_id
        // was captured once, at the top of this function, before the per-page rasterizePageWithRetry
        // loop above — several real, sequential network round-trips for a multi-page resume, easily
        // several seconds. If the candidate confirmed their signup email during that window,
        // confirm-verification's one-time backfill would have already set resume_documents.candidate_id
        // (finding no child rows yet to fix, since they don't exist until the insert below) — using
        // the stale captured value here would permanently orphan every row this call is about to
        // insert. Re-reading it fresh, immediately before the insert, shrinks that window to one query.
        const { data: freshDocPdf } = await supabase
          .from("resume_documents").select("candidate_id").eq("id", docId).maybeSingle();
        const { error: pdfRpcErr } = await supabase.rpc("insert_resume_extraction", {
          p_resume_document_id: docId,
          p_candidate_id: freshDocPdf?.candidate_id ?? docRow.candidate_id,
          p_work_history: merged.work_history,
          p_education: merged.education,
          p_certifications: merged.certifications,
          p_skills: merged.skills,
          p_skills_position: merged.skills_position ?? null,
          p_freeform: merged.freeform,
          p_ocr_text: combinedOcrText,
          p_candidate_location: merged.candidate_location || null,
          p_printed_header: merged.printed_header || null,
        });
        if (pdfRpcErr) {
          await supabase.from("resume_documents").update({ extraction_status: "failed" }).eq("id", docId);
          return new Response(JSON.stringify({ ok: false, error: "insert_failed", detail: pdfRpcErr.message, resume_document_id: docId }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // ocr_raw_text: previously written only by the single-image tesseract branch below (see
        // that branch's own update() call) — never for a PDF. Written here now too, real retained
        // value beyond just feeding certification_source_match above: an auditable record of what
        // the pipeline actually read off the document, the same reason it was already kept for
        // images. Best-effort — a failure here doesn't fail the upload; the extraction itself
        // already succeeded and was already inserted above.
        await supabase.from("resume_documents").update({ ocr_raw_text: combinedOcrText }).eq("id", docId);

        const { error: pdfStatusErr } = await supabase
          .from("resume_documents")
          .update({ extraction_status: "extracted", extracted_at: new Date().toISOString() })
          .eq("id", docId);
        if (pdfStatusErr) {
          return new Response(JSON.stringify({ ok: false, error: "status_update_failed", detail: pdfStatusErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: signedPdf } = await supabase.storage.from(BUCKET).createSignedUrl(originalPath, 3600);
        return new Response(JSON.stringify({
          ok: true,
          resume_document_id: docId,
          extraction_status: "extracted",
          extraction_method: "pdf_rasterize",
          page_count: pageCount,
          original_signed_url: signedPdf?.signedUrl ?? null,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

        // Item 1 (2026-09-08 regression session): same race-window fix as the PDF branch above and
        // extract-resume-fields — docRow.candidate_id was captured before the vision call just made
        // (a real, network-bound Claude call), which is exactly the window a fast signup-email
        // confirmation could land in and permanently orphan every row about to be inserted.
        const { data: freshDocVision } = await supabase
          .from("resume_documents").select("candidate_id").eq("id", docId).maybeSingle();
        const { error: rpcErr } = await supabase.rpc("insert_resume_extraction", {
          p_resume_document_id: docId,
          p_candidate_id: freshDocVision?.candidate_id ?? docRow.candidate_id,
          p_work_history: extraction.work_history,
          p_education: extraction.education,
          p_certifications: extraction.certifications,
          p_skills: extraction.skills,
          p_skills_position: extraction.skills_position ?? null,
          p_freeform: extraction.freeform,
          // Explicit null, not omitted: this path is vision-only by construction (that's the whole
          // reason it exists — see this branch's own header), so there is no OCR text and never
          // will be for a document that came through here. certification_source_match's own
          // contract treats null as "not_checked," an honest "couldn't verify either way," not a
          // false "unmatched" — see the migration that introduced it.
          p_ocr_text: null,
          p_candidate_location: extraction.candidate_location || null,
          p_printed_header: extraction.printed_header || null,
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
