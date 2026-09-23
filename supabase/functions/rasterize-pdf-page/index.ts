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

CLASSIFICATION IS SECTION-DRIVEN, DECIDED BEFORE THIS STEP — READ THIS FIRST (Decision 38, 2026-09-18):
the category every item below belongs to is NOT something this step decides by judging an individual
item's own shape or content pattern. It was already decided, per-SECTION, in a separate step that ran
before this one — see "SECTION BOUNDARIES FOR THIS PAGE" further down this prompt (when present) for
the actual, final category of every section on this page. Once a section's category is fixed, every
item under it gets that category, full stop — do not independently re-judge a specific item against
these category definitions by its own shape or wording once it's inside an already-assigned section.
These definitions below describe what a category MEANS and how to extract its fields correctly once
assigned (heading capture, line breaks, license numbers, date rules, and so on) — not how to decide
category in the first place; that decision is upstream of this step now.

THE ONE EXCEPTION — GENUINELY HEADERLESS CONTENT (a real, confirmed failure mode this exception exists
to cover — a plain, minimally-formatted document with no section headings at all, no bold text, no
visual separation whatsoever, still has real work history, education, and certifications on it, and
they must still be extracted into their real structured categories, not dumped into needs_review just
because nothing labels them): when the section-boundary step marked a section "unknown" specifically
because it found NO heading at all governing that content (not because a real heading didn't
semantically match a known category — see the disambiguation rule further below for that different
case), fall back to judging that specific content by its own inherent shape and content pattern. A
line naming a trade or credential followed by a license/certification/registration number (e.g.
"Plumber" then "Lic # CFC1425829", "License No. 12345", "Cert #A-9982") is a certifications entry by
that shape alone, the same way a company+title+date-range pattern identifies work_history and a
degree+institution pattern identifies education — but ONLY reach for this fallback inside a section
the boundary step already flagged as genuinely headerless "unknown", never as a general override for
a section that already has a real, assigned category.

MULTI-COLUMN TABLE READING ORDER (real, confirmed failure mode, twice — once fixed for row-by-row
reading order, then found still broken: a section laid out as a 2- or 3-column grid of short bullet
cells, e.g. "Selected Career Highlights" or similar, got its cells read left-to-right across the
grid as one continuous stream instead of down each column separately. Two symptoms of the same root
cause were both observed on the same real document: unrelated cells' sentences spliced together
mid-sentence, and single words split across a column boundary with a stray fragment left dangling on
each side, e.g. "_satisfaction" and "_delivery" as the broken halves of "customer satisfaction" and
"on-time project delivery"). DO NOT attempt to preserve the grid's row-by-row layout in your reading
order at all — flatten it instead: read one column completely, top to bottom, start to finish,
before reading the next column at all (the leftmost visual column on THIS page first, then the
column to its right, and so on) — never read across a row from one column's cell into another
column's cell, and never let a row boundary decide reading order. Each cell is a separate, complete
bullet; extract the whole grid as ONE flat, linear, sequential list of complete bullets in that
column-by-column order, never merging two cells' text into one bullet and never leaving a word or
clause fragment from one cell joined onto another's. This applies to ANY section on THIS page laid
out as a multi-column table or grid of short bullet cells, not just a section named "Selected Career
Highlights" — judge by the page's own visual SHAPE (a grid of short items in aligned columns), not
by section heading. There is no requirement to preserve the original column layout in your output —
the generated result only ever shows this content as a single linear list regardless, so when in
doubt, prefer keeping each cell's own sentence fully intact and separate over guessing at a merged
reading order.

FIELD AND CATEGORY DEFINITIONS — read carefully, these are not interchangeable buckets:

- "candidate_location" (top-level, not inside any category) = the candidate's OWN personal
  location, as printed near their name/contact line at the top of the resume (e.g. "Sebastian FL",
  "Austin, TX") — copy it verbatim, in whatever form it's printed. This is NOT the same field as
  work_history's or education's own "location" (an employer's or institution's location) — never
  confuse the two, and never copy an employer/institution location into this field just because the
  candidate's own location wasn't printed. Use an empty string "" when no personal location is
  printed anywhere on THIS page — never infer or guess one.

- "printed_header" (top-level, not inside any category) = the ENTIRE personal-info header block
  exactly as printed at the top of the resume — the candidate's own name (including any middle
  initial, suffix like "Jr." or "Sr.", or professional qualifier like "Esq." or "PE", exactly as
  printed, in whatever order and case it appears), plus every contact/location line printed
  alongside it (phone, email, mailing address, city/state, LinkedIn URL, etc.), if THIS page is the
  one that shows it. Captured as ONE literal block of text — never parsed into separate name/phone/
  email/location parts, unlike candidate_location above, which stays a separate, structured field
  for exactly the location piece. Preserve the resume's own line breaks using "\n" between them;
  copy every character verbatim, including capitalization and punctuation — never reformat,
  reorder, translate, or normalize anything, and never add or drop words. Use an empty string ""
  when THIS page doesn't show that header block at all (true for every page but the one with it) —
  never invent or reconstruct one.

- LINE-BREAK PRESERVATION (real, confirmed failure mode — a real source document with bulleted
  content came back as one dense, run-on paragraph with every bullet's line break silently
  discarded): this applies to "job_responsibilities" (work_history) and "content" (freeform) alike.
  Whenever THIS page presents this field's content as distinct bullets, dashes, or separate lines —
  not as flowing prose — reproduce that structure verbatim using "\n" between each item. Judge this
  the same way as everywhere else in this prompt: by the source's own SHAPE, not by whether a bullet
  character is literally present — a "Selected Career Highlights" or "Workplace Strengths" section
  printed as one item per line is a real line-separated list even without a visible bullet glyph,
  and job_responsibilities under a role is virtually always this shape (each responsibility its own
  line/bullet in the source). The one genuine exception is content that is actually continuous prose
  on THIS page (a paragraph-style professional summary, a single unbulleted sentence) — that stays
  as normal wrapped prose, no "\n" inserted where the source never had one. Never collapse a real
  bulleted list into a single comma- or period-joined sentence, and never invent a line break the
  source doesn't actually have. (Note: this page's own extraction is later merged with adjacent
  pages' extractions of the same continuing entry — see upload-resume's own merge logic — so getting
  THIS page's own line breaks right matters even when the full entry spans more than one page.)

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

- work_history's "heading" field = the literal heading/label text of the OUTER SECTION this entry sits
  under on THIS page, exactly as printed (e.g. "PROFESSIONAL EXPERIENCE", "Employment History") — the
  ONE section title that governs the entire block of company entries, copied verbatim, not reworded,
  not invented, not guessed. It is NEVER an individual company's own header line (e.g. "CDW, Remote
  November 2015 - September 2020"), even though that line is often bold, sits on its own line, and sits
  directly above the role/title and bullets — exactly the way a real section heading looks. That
  company-level line belongs in the separate "company", "location", "start_date", and "end_date" fields
  instead; it must never be copied into "heading". A real, confirmed failure mode: on a resume with one
  outer "PROFESSIONAL EXPERIENCE" heading governing five different companies, four of the five got
  their OWN "COMPANY, Remote [date] [date]" line as "heading" instead of "PROFESSIONAL EXPERIENCE"
  (only the fifth got it right) — and while copying that wrong text, the hyphen between the two dates
  was also dropped, so the same mistake corrupted two different things at once. When two or more
  consecutive entries on this page share the same visible section heading, every one of them gets that
  same literal heading string, not just the first, and never a company's own line instead. Use an empty
  string "" only when this page genuinely shows no visible section heading above this entry at all
  (e.g. a minimally-formatted page with no section labels at all, per THE ONE EXCEPTION rule above, or
  a continuation entry whose heading was only printed on a previous page). This is additive only, like
  freeform's own "heading" field below — it does not change how content gets classified, only what
  section title the output can reproduce.

- SAME COMPANY, MULTIPLE ROLES — RUN THIS GATING TEST FIRST, before weighing any promotion or
  transition language, whenever a company name appears more than once in the work-history section
  ON THIS PAGE (a role split across a page boundary is handled by the separate continuation-merge step
  downstream, not here). Still getting this wrong after two earlier, weaker-worded attempts at this
  exact fix, 2026-09-23 — this version leads with the test itself rather than stating it as one
  consideration among several:

  GATING TEST — count the COMPLETE header lines naming this company. A complete header line is one
  that, by itself, states a title, this company, and a date range — the same shape every other
  employer entry in this section uses (e.g. "Title | Company | Location | Dates", or whatever exact
  header shape this resume uses elsewhere).
    - Count == 1 (only one complete header line names this company; any other role is mentioned ONLY
      as a subordinate aside UNDER that one header — a parenthetical, an italicized note, a short line
      like "Promoted mid-year from Desktop Publishing Manager (1996-1997)" that does NOT itself state
      its own title+company+dates as a standalone header) → MERGE-ELIGIBLE. Go to "HOW TO MERGE" below.
    - Count >= 2 (two or more complete header lines each independently name this company, each with
      its own title and its own date range) → NOT MERGE-ELIGIBLE. STOP HERE. Extract one work_history
      entry per header line, each keeping its own real title and its own real start_date/end_date
      exactly as printed on that line. Do not proceed to "HOW TO MERGE" for this company at all.
      This stays NOT MERGE-ELIGIBLE even when one of the header lines carries a caption that explicitly
      frames it as a continuation or promotion (e.g. "Role transition; retained [prior title] title of
      record," "Promoted from...") — a caption on one header does not erase the fact that the OTHER
      role still has its own separate, complete header line elsewhere. The caption is real content and
      belongs inside that entry's own job_responsibilities; it is never, by itself, permission to fold
      a second, independently headed entry into the first. Once the count comes back >= 2, the caption
      cannot change the answer — do not re-run this test against the caption's wording.

  A real, confirmed failure mode (this exact case — count == 2, both header lines complete — got
  merged anyway, twice, across two earlier attempts at this fix): "Business Education Teacher | School
  District of Indian River County | Sebastian, FL | 2018 - 2025" and "Associate Dean of Discipline |
  School District of Indian River County | Sebastian, FL | 2025 - 2026," the second captioned "Role
  transition; retained Business Education Teacher title of record per district process." Count the
  headers: two complete header lines, so NOT MERGE-ELIGIBLE — this must produce two separate
  work_history entries, "Business Education Teacher" ending 2025 and "Associate Dean of Discipline"
  ending 2026, never a single merged "Business Education Teacher to Associate Dean of Discipline" entry
  and never a fabricated open-ended/"Present" end date on either one.

  HOW TO MERGE (only reached when the gating test above found exactly count == 1 — one company-level
  header followed by one or more role sub-entries mentioned only as subordinate asides beneath it, an
  internal promotion or title change within that single tenure): combine it into ONE work_history
  entry, never one entry per role:
    - "company" = the employer's name, copied verbatim once.
    - "title" = every role's own title, in chronological order, joined as "First Title to Second Title"
      (extend the same way for three or more roles) — e.g. "Recruiter to Senior Recruiter" — never just
      the most senior/most recent title alone, which would misrepresent the whole tenure as having
      started at that level.
    - "start_date" = the EARLIEST role's own start date. "end_date" = the LATEST role's own end date
      (or the current-role rule below if that latest role is still ongoing).
    - "job_responsibilities" = rebuild the full internal structure as one piece of text, nothing
      dropped: first, any company-level description or context that applies to the whole tenure and
      isn't specific to either individual role (what the company does, an acquisition note, and
      similar) — copied verbatim, on its own line(s); then, for each role in chronological order, a
      line naming that role and its own exact date range (e.g. "Recruiter, September 2023 - June
      2024:"), followed by that role's own bullets exactly as printed, using "\n" between lines per the
      LINE-BREAK PRESERVATION rule above. Never shorten, summarize, or drop any real content from either
      role or from the company-level context while combining them — the combining is structural only.

  Separately, do NOT apply any of this (merge or not) when two entries merely share an employer NAME
  but read as genuinely separate, disconnected stints — a real gap where the candidate left and later
  came back, or two different contract engagements at the same staffing client years apart with no
  connecting language at all. That is a different situation from the gating test above (which handles
  same-tenure cases); when genuinely unsure whether two same-company entries on this page are one
  continuous tenure or two disconnected stints, extract them as separate entries rather than guessing.

- education = DEGREE-GRANTING PROGRAMS ONLY (e.g. B.A., B.S., M.S., MBA, Ph.D., Associate's).

- education's "location" field = the institution's city/state (or city/country outside the US) as
  printed on the resume, near the institution's name, e.g. "Gainesville, FL". Copy it verbatim in
  whatever form it appears — do not reformat, abbreviate, or expand it. Use an empty string "" when
  no location is given for that institution — never infer or guess one from the institution's real-
  world location; only what's actually printed counts.

- education's "heading" field = the same concept as work_history's "heading" above, for whatever
  section this program sits under on THIS page (e.g. "EDUCATION", "Academic Background") — literal
  text, verbatim, the same shared string across every entry under one visible heading, empty string
  "" only when this page genuinely shows none.

- education's "degree" and "field_of_study" fields must preserve the resume's own qualifying or
  partial-completion language VERBATIM — never simplify, clean up, or drop words like "coursework
  toward," "in progress," "incomplete," "partial completion," "expected [year]," or a credit/hour count
  in parentheses (e.g. "(60 credits completed)") when the resume's own phrasing includes them. A real,
  confirmed failure mode: a resume reading "coursework toward Bachelor of Science (60 credits
  completed)" under a Travel and Tourism major came back as bare "Bachelor of Science" / "Travel and
  Tourism" — silently dropping "coursework toward" and "(60 credits completed)" entirely, which turns a
  stated INCOMPLETE credential into what reads as a completed one. That is never acceptable regardless
  of how much cleaner the shortened form looks: if the resume's own words for a degree qualify,
  partially complete, or hedge it in any way, those exact words are part of "degree" (or
  "field_of_study", whichever the qualifying language sits closest to in the source line) and must
  appear in the output exactly as printed — never trimmed down to just the degree title and major name.
  This holds for every entry, not only ones that look unusual; do not "normalize" a degree line to its
  cleanest-looking form just because most other entries on the page happen to already be complete,
  unqualified degrees.

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

- A COMPACT, DELIMITER-LESS LICENSE LINE IS ONE ENTRY, NEVER TWO (applies generally, inside any
  certifications-category section, whether or not that section has its own visible heading — this is
  not limited to the headerless fallback above): a single line that packs a trade/credential name, a
  2-letter US state abbreviation, and a license-number marker together with nothing but plain spaces
  between them and no comma, pipe, dash, or other delimiter — e.g. "Plumber FL Lic # CFC1425829" — is
  ONE certifications entry, not two and not three. Read it as [trade/credential name] [state
  abbreviation] [license marker + number]: "name" gets the trade/credential portion only (e.g.
  "Plumber"), "license_number" gets the number after the marker (e.g. "CFC1425829"). The bare 2-letter
  state token in the middle (e.g. "FL") is never itself a separate credential and must NEVER become
  its own certifications entry, its own "name" value, or a standalone freeform/needs_review item — it
  identifies which state issued THIS SAME license, nothing more; there is no dedicated field for it in
  this schema (a separate downstream pass re-derives the issuing state independently), so simply leave
  it out of the output rather than inventing a place to put it. One packed line, one entry — never let
  a bare state abbreviation cause it to split into more than one.

- certifications' "issuing_body" field = the organization, platform, or provider that issued,
  administers, or hosts the credential, when the resume actually identifies one. SHARED-CONTEXT
  INHERITANCE (a real, confirmed gap, 2026-09-14): when a SINGLE provider name is printed ONCE as a
  shared label governing a whole itemized list of credentials — e.g. a heading reading "AI &
  Emerging Technology Certifications — Coursiv," or a provider name printed once above or beside a
  bulleted list, never repeated next to each individual bullet — that same issuing_body applies to
  EVERY item in that list. Determine this by which list an item genuinely belongs to (same heading,
  same bulleted group), never by how visually close the shared label happens to sit to that specific
  item's own position on the page. Reproduced live: a real 9-item list under one shared "Coursiv"
  label had items 1-8 (a single column) correctly get issuing_body "Coursiv" — but item 9, the same
  list, just wrapped into a second column sharing a printed row with item 8, came back with
  issuing_body empty, even though its own "name" field extracted correctly (this was not a general
  extraction-quality problem for that item, only the inherited field failed to carry over). The
  column an item happens to sit in is never a reason to withhold a shared value every other item in
  its own list already receives — if items 1-8 of a list get a shared issuing_body, item 9 of the
  SAME list gets it too, regardless of which column, row, or page position it prints in. Use an
  empty string "" only when the resume genuinely never identifies any issuing body for that list at
  all, never because one particular item's own position made the shared label harder to visually
  associate with it.

- certifications' "heading" field = the section's own literal heading/label text, copied verbatim IN
  FULL, including any trailing parenthetical or annotation that's part of the same heading line (e.g.
  a heading printed as "AI & Emerging Technology Certifications — Coursiv (55+ Hours)" is captured as
  that ENTIRE string, parenthetical and all — never split off, never dropped, and never turned into a
  separate needs_review entry of its own). Extracting "issuing_body" (e.g. "Coursiv") out of that same
  heading line is a SEPARATE, ADDITIONAL operation, not an alternative to capturing "heading" — do
  both. Shared the same way issuing_body is shared: every item under one visible heading on this page
  gets that same literal heading string. A trailing annotation inside a heading (an hours figure, a
  date range, a parenthetical note) is part of that heading text, never a standalone fact needing its
  own home elsewhere in the output. Use an empty string "" only when this page genuinely shows no
  visible heading for that list at all.

- CERT/LICENSE VS. SKILL DISAMBIGUATION WITHIN A MIXED SECTION (a targeted rule, not a universal
  requirement — most certifications and skills are unambiguous by shape per their own definitions
  above and need none of this, and per the section-driven classification rule above, this NEVER fires
  inside a section the boundary step already assigned a real category to): this applies ONLY inside a
  section the boundary step marked "unknown" — either genuinely headerless, or a real header that
  didn't semantically match any known category — AND that section's own content shows a genuine
  MIX — some items with a clearly discernible trailing certification/license number or identifier (a
  distinct number, code, or alphanumeric string following the item's name, whether or
  not it carries a conventional marker like "#", "No.", or "Lic. No." in front of it) and other items
  in that same section with no such identifier at all. When that specific mix occurs inside such a
  section, use the
  presence or absence of a discernible trailing identifier as the signal to split the section: items
  with one are certifications (the identifier captured in "license_number"), items without one are
  skills. Do NOT apply this as a blanket requirement for every certification — most legitimately have
  no license number (see the license_number field above) and are still certifications, classified
  normally. A trailing identifier can be genuinely hard to tell apart from ordinary text (a website
  address, a plain string of letters and numbers) with no conventional marker present — when a
  specific item's status is still ambiguous after applying this rule (you can't confidently tell
  whether a trailing string is really an identifier, or whether that item belongs with the
  certifications or the skills in this same mixed section), do not guess: classify that one item as
  "needs_review" instead, with its "heading" set to the section's real literal heading text and its
  "content" holding that item's own text verbatim — rather than forcing an ambiguous item into either
  certifications or skills.

- DON'T SPLIT A SINGLE WRAPPED ITEM INTO TWO (a real, confirmed failure mode — confirmed twice against
  the same real document): a single certification name, skill, competency, or other list item whose
  text is long enough to visually wrap onto a second printed line — purely because it ran out of
  column/page width, not because a new bullet started — is still ONE item, not two. Real example: a
  certifications-list entry reading "Multimodal AI & Productivity Integration (Gemini)" came back
  split into two separate certifications entries, one credential name broken in half. This applies
  identically to certifications, skills, and every other category that extracts a list of individually
  named items — it is not a skills-only rule. Judge this by whether a new bullet glyph, dash, or clear
  left-margin/indentation reset marks the start of the second line: if it does, it's a genuine new
  item; if the second line simply continues flush with no marker of its own (a mid-word or mid-phrase
  continuation of the same thought), join it back onto the item it wrapped from before adding it to
  certifications, skills, or any other array of short terms — never emit the wrapped tail as its own
  separate entry.

- AN INTERNAL "&" (OR "AND") WITHIN ONE ITEM'S OWN NAME IS NEVER A SPLIT SIGNAL BY ITSELF (a real,
  confirmed failure mode, distinct from the wrapped-line case above — this one happens WITHIN a
  single printed line, no wrap involved at all): many certification, skill, and other list-item
  names legitimately contain an internal "&" as part of ONE compound name — e.g. "Conversational AI
  & Workflow Automation", "Diffusion Models & Creative AI", "AI Content Creation & Marketing
  Automation" are each one item, not two, even though each names two connected concepts joined by
  "&". The presence of an "&" never by itself means two separate items are present. Real, confirmed
  example: "Multimodal AI & Productivity Integration (Gemini)" — one single printed line, one
  bullet, no line break, no second bullet glyph anywhere near it — was still split into two
  certifications entries ("Multimodal Productivity (Gemini)" and "AI & Integration"), with words
  from the middle of the name reordered and separated in the process. Nothing in the source marked
  a second item starting there. Only split an item at an internal "&" when there is a clear,
  independent structural marker that a NEW item genuinely begins — its own bullet or dash, a real
  line break in the source, or an unambiguous comma-separated list format (e.g. "A, B & C" printed
  as one line clearly listing three distinct items). Absent one of those markers, treat the entire
  phrase on both sides of the "&" as one single item name, copied verbatim in its original word
  order — never reordered, never with a word dropped or moved to "belong" to only one side.

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

  NOT skills-shaped (a real, confirmed failure mode): a bulleted list where EACH item pairs a short
  bolded/leading phrase with its OWN explanatory clause — a dash, en-dash, em-dash, or colon
  followed by a descriptive sentence about that item (e.g. "Strategic Thinking & Analytical Problem
  Solving — approaches challenges with a big-picture mindset while maintaining rigorous attention to
  operational detail"). The leading phrase alone can look exactly like a skill/competency term, but
  the presence of that per-item explanatory clause means the section is NOT a flat list of terms —
  it's a distinct named section (commonly titled "Workplace Strengths," "Key Strengths," "Core
  Values," or similar) and must be classified under needs_review, using its own real heading,
  never folded into skills. This holds even when THIS page (or an earlier page) also has a genuinely
  skills-shaped section (e.g. "Core Competencies") — a second bulleted list elsewhere is NOT
  automatically more of the same skills block just because its individual phrases look similar;
  check each item for its own explanatory clause before adding anything to skills. If THIS page
  opens with bulleted short phrases and NO section heading is visible above them on THIS page (the
  heading was printed on a previous page), do not default to skills just because there's nothing
  else to classify it as — this is the "unlabeled continuation of a previous section" case described
  in the freeform heading rule below (empty "heading", section_type "needs_review"), which the
  upload pipeline merges into the correctly-headed part from the prior page.

- MULTIPLE DISTINCT SKILLS-SHAPED SECTIONS ON THIS SAME PAGE (a real, confirmed structure, different
  from the case just above — this one is about two sections that are BOTH genuinely skills-shaped, not
  one that only looks like it is; scoped to both being visible on THIS page — this call has no reliable
  way to know whether an earlier page already had a skills-shaped section, so this rule only applies
  when you can see two or more such sections yourself, on this one page): when THIS page shows more
  than one section that is a genuine flat list of terms, each with its own distinct heading — e.g. "CORE
  COMPETENCIES" (a list of competency phrases) immediately followed by "RECENT TECHNICAL SKILLS" (a list
  of named tools/software), two real, differently-headed lists back to back — the top-level "skills"
  array is ONE flat, unattributed list, so only the FIRST such section on this page's terms go into
  "skills" (carrying that section's own heading the usual way, via the section-boundary step). Every
  ADDITIONAL skills-shaped section on THIS SAME page — one with its own genuinely different heading text
  — goes into "freeform" instead of being merged into "skills": section_type "skills_secondary",
  "heading" set to that section's own literal heading text, "content" holding its terms exactly as the
  source presents them (comma-separated, one per line, however the source actually lists them — copied
  verbatim, not reformatted into a different list style). Never merge a second skills-shaped section's
  terms into the "skills" array just because both sections are skills-shaped — doing so silently
  discards the second section's own heading and visually merges two genuinely distinct sections into
  one. This does not apply to a single skills section that merely wraps across multiple lines or columns
  on this page (still one section, one heading) — only to two or more sections with genuinely distinct
  heading text, per the general "never merge sections just because they're topically similar" rule.

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
  item is. Perform this silently: a real, confirmed failure mode had a needs_review "content" field
  come back containing a parenthetical note explaining WHICH items were left out and why they were
  considered duplicates — that meta-commentary is not resume content and must never appear inside
  any field's value. "content" (and every other field) holds only what's actually printed on the
  page, verbatim; your own reasoning about deduplication, classification, or anything else belongs
  nowhere in the output.

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
  nothing else at all (a single section filling the whole page), position values still start at 0.
  Each entry's position must be genuinely unique on THIS page (real, confirmed failure mode: four
  separate certification bullets under one heading all came back with the identical position value
  — harmless by coincidence that time since nothing else fell between them once sorted, but not a
  safe pattern to rely on) — every entry has its own distinct reading-order spot, never shared with
  a sibling entry even when several appear close together or under the same heading. If several
  items truly sit on the exact same visual line (rare), give them consecutive integers in the order
  a reader's eye would actually take them (e.g. left-to-right for a same-row pair), not the same
  number.`;

const SCHEMA_SHAPE = `{
  "candidate_location": string,
  "printed_header": string,
  "work_history": [
    { "company": string, "title": string, "location": string, "start_date": string, "end_date": string,
      "job_responsibilities": string, "extraction_confidence": "high" | "medium" | "low", "position": number, "heading": string }
  ],
  "education": [
    { "institution": string, "degree": string, "field_of_study": string, "location": string,
      "start_date": string, "end_date": string, "extraction_confidence": "high" | "medium" | "low", "position": number, "heading": string }
  ],
  "certifications": [
    { "name": string, "issuing_body": string, "license_number": string, "issue_date": string, "expiration_date": string,
      "extraction_confidence": "high" | "medium" | "low", "position": number, "heading": string }
  ],
  "skills": [ string ],
  "skills_position": number | null,
  "freeform": [
    { "section_type": "summary" | "hobbies_other" | "needs_review" | "skills_secondary", "heading": string, "content": string, "position": number }
  ]
}`;

const DATE_RULES = `DATES: write every date exactly as precisely as the resume prints it, never more precisely. Use YYYY
when the resume gives only a year, YYYY-MM when it gives a month and year, and YYYY-MM-DD only when it
gives a specific day (rare). NEVER fill in a month or day the resume does not show: a bare "2019" is
"2019", not "2019-01" and not "2019-01-01". If a role/program is current/ongoing ("Present", "Current",
"Now"), write the word Present as its end_date. If a date is entirely absent or unrecoverable, use an
empty string "" for that field, not a guess.

If a category has no entries, return an empty array for it — do not omit the key.`;

// STEP 1 OF 2: SECTION-BOUNDARY DETECTION — Decision 38 (2026-09-18), replacing item-level
// shape-driven classification with a genuine two-step structural process, not another prompt-prose
// patch layered on the old one-call design. Root cause, confirmed this week via direct-probe evidence
// (see verifi-extraction-nondeterminism-open-item memory, the "phantom-duplicate" investigation): a
// single combined call asked to BOTH capture a section's heading AND classify its items by shape
// treated those as two independent, competing actions within one completion — producing a shape-based
// misclassification (e.g. a "Professional Certifications" list landing in skills) AND a separate,
// redundant needs_review echo of the heading text, in the SAME response, 19/19 times on isolated clean
// input at temperature:0. That's one coherent (if wrong) model behavior, not two coincidental bugs —
// and a same-call fix (asking the model to "coordinate" the two actions more carefully in prose)
// doesn't structurally rule it out, since nothing stops it from independently deciding both things
// again in one pass. Two literal separate calls do: this step ONLY identifies section boundaries and
// assigns each one a category by matching its header's MEANING (semantically, not exact string)
// against the known internal categories below — no item extraction happens here, so there is no
// shape-classification decision for this step to compete with. Step 2 (buildOcrExtractionPrompt /
// buildVisionExtractionPrompt below) receives this step's result as an already-decided fact and
// extracts items strictly within it — see buildSectionBoundaryBlock below for how that's enforced.
const KNOWN_CATEGORIES_GUIDE = `KNOWN INTERNAL CATEGORIES — match a section's header by its MEANING, not by exact wording. Common
real-world header phrasings for each (not exhaustive — judge by meaning; any header that clearly names
the same concept counts, however it's actually worded):
- work_history: "Experience", "Work History", "Professional Experience", "Employment History", "Job
  Description", "Career History", or similar — paid employment.
- education: "Education", "Academic Background", "Degrees", or similar — degree-granting programs.
- certifications: "Certifications", "Licenses", "Professional Certifications", "Credentials",
  "Licenses & Certifications", or similar — licenses and certifications are the SAME internal category
  here, never split into two different categories.
- skills: "Skills", "Core Competencies", "Technical Skills", "Areas of Expertise", "Key Skills", or
  similar — a flat list of individual skill/competency terms.
- summary: "Summary", "Professional Summary", "Objective", "About Me", or similar — an intro blurb
  near the top of the resume.
- hobbies_other: "Interests", "Hobbies", "Volunteer Work", "Community Involvement", or similar.
If a section's header doesn't semantically match ANY of the above — a real header exists, but names
something else entirely (e.g. "Career Highlights," "Workplace Strengths," "Achievements") — its
category is "unknown". This is not a failure state: "unknown" content is real, gets captured in full,
and is unconditionally flagged for a human to review (never silently dropped, never forced into a
category it doesn't belong in just to avoid "unknown") — this is the anti-gaming design: a candidate
cannot route real content around verification by mislabeling its own section header.`;

// Inline label + enumerated list as an undressed section boundary (2026-09-22), mirrored from
// extract-resume-fields/index.ts (see that file's own header comment for the full root-cause story —
// a resume's Summary paragraph ended with "Experience Areas: o software development o technology
// infrastructure o ..." and the whole list landed as trailing Summary text instead of being split into
// skills, because it never looked like a heading — no standalone line, no blank-line break from the
// prose before it). Deliberately narrow and structural (glyph-pattern based, not a content-shape
// judgment) so it doesn't reopen the door Decision 38 closed on Step 2 re-judging category by shape —
// this only decides where one section ENDS and the next begins, never what's inside either one.
const INLINE_LABEL_LIST_BOUNDARY_RULE = `INLINE LABEL + LIST AS A SECTION BOUNDARY (a narrow, structural exception — most section boundaries
are ordinary standalone headings and need none of this): sometimes a page shifts from flowing prose
directly into an enumerated list with no standalone heading line of its own — just a short label ending
in a colon (e.g. "Experience Areas:", "Key Skills:", "Areas of Expertise:") immediately followed by 3 or
more bullet/dash-marked items that each read as a short term or phrase, not a full sentence. Treat that
label as a heading and END the section it would otherwise be trailing inside right before it, starting a
new section there — heading = the label text (drop the trailing colon), category decided the normal way,
by matching that label's meaning against the KNOWN INTERNAL CATEGORIES above (an "Experience Areas" or
"Key Skills" label matches skills the same as any standalone heading would).

This is scoped narrowly: it does NOT apply when the label+list sits inside a single work-history job's
own bulleted description — e.g. "Responsibilities:" or "Key initiatives included:" followed by several
bullets UNDER a specific company/title entry is part of that job's own content, not a new top-level
section; never split a job entry apart this way. Judge the difference structurally, not by the label's
wording: a free-standing paragraph transition (typically closing out a Summary/Objective, with no
enclosing job heading directly above the label) is a real boundary; a label appearing as one more bullet
within a job's existing bulleted duties list is not. When you cannot confidently tell which of the two
this is, do not guess — leave the content inside its current section exactly as you would have without
this rule.`;

type BoundaryCategory = "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "unknown";

type BoundarySection = {
  heading: string;
  category: BoundaryCategory;
  is_continuation_of_previous_page: boolean;
};

type BoundaryResult = { sections: BoundarySection[] };

// The Skills block's own literal heading (2026-09-21). NO extraction prompt carries it (adding a field to those prompts measurably changed how one job
// bullet was transcribed, so they stay byte-for-byte as they were): it comes from the section-boundary step, the call that already reads every section's
// heading to classify it. The first section that step called "skills" and gave a non-empty heading supplies it. When the boundary step failed, found no
// skills section, or gave that section no heading, the answer is "" and every screen falls back to "Skills" exactly as before. Nothing is stored when no
// skills were extracted (a heading with nothing under it belongs to nothing). One string per resume; whitespace collapsed, length-capped.
function cleanHeading(s: unknown): string { return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 200) : ""; }
function resolveSkillsHeading(boundaries: BoundaryResult | null | undefined, extraction: { skills?: unknown }): string {
  if (!boundaries || !Array.isArray(extraction.skills) || !extraction.skills.some((x) => typeof x === "string" && x.trim())) return "";
  const b = boundaries.sections.find((s) => s.category === "skills" && cleanHeading(s.heading));
  return b ? cleanHeading(b.heading) : "";
}

const BOUNDARY_SCHEMA_SHAPE = `{
  "sections": [
    { "heading": string, "category": "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "unknown", "is_continuation_of_previous_page": boolean }
  ]
}`;

function buildBoundaryDetectionInstructions(previousPageContext?: TrailingItemContext | null): string {
  const continuationNote = previousPageContext
    ? `

CONTINUATION AWARENESS: the previous page ended mid-way through ${
        previousPageContext.kind === "work_history"
          ? `a work-history entry at "${previousPageContext.company || "(unnamed)"}"`
          : previousPageContext.kind === "certifications_list"
          ? `a certifications list${previousPageContext.heading ? ` under heading "${previousPageContext.heading}"` : ""}`
          : `a freeform section${previousPageContext.heading ? ` titled "${previousPageContext.heading}"` : ""}`
      }. If THIS page opens with content that plainly continues that — no new heading before it — mark
that opening section's "is_continuation_of_previous_page" as true and give it the SAME category as the
open item described above, even though this page shows no heading of its own for it (a continuation
never repeats its header). The instant a genuinely NEW heading appears — even one that also sounds
related (e.g. a different certifications heading following the one above) — that starts a brand-new
section with its own independent category decision, never treated as more of the previous one just
because it's topically similar.`
    : "";

  return `Identify every distinct SECTION on this page and assign each one a category — nothing else, at
this step. A section is a heading plus everything under it up to the next heading (or the end of the
page). If this page (or its opening portion, before any first heading) has real content with NO
heading at all governing it, that is still one section — heading="" — do not guess a category for it
based on its content's shape; give it category "unknown" here (step 2 of this pipeline has its own,
separate shape-based fallback for genuinely headerless content — resolving that is not this step's job).

Do NOT read, extract, or judge individual items inside any section at this step — you are drawing
boundaries and matching header MEANING only. Nothing about what's inside a section (its shape, its item
count, whether individual items look like one category or another) should influence its category here.
Two sections can share the same broad topic (e.g. two different certifications-style headings on the
same page) and still be two separate sections if they have two separate, distinct heading strings —
never merge them into one just because they're topically similar; a genuinely different heading string
always starts a new section.

${KNOWN_CATEGORIES_GUIDE}

${INLINE_LABEL_LIST_BOUNDARY_RULE}${continuationNote}

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${BOUNDARY_SCHEMA_SHAPE}`;
}

function buildBoundaryDetectionPromptText(ocrText: string, previousPageContext?: TrailingItemContext | null): string {
  return `You are analyzing the raw OCR text of one page of a resume to identify its section boundaries
only — not to extract any data yet. The OCR text below may contain recognition errors (misread
characters, words glued together, minor garbling); read through that when identifying headings.

${buildBoundaryDetectionInstructions(previousPageContext)}

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
}

function buildBoundaryDetectionPromptVision(previousPageContext?: TrailingItemContext | null): string {
  return `You are analyzing the attached image of one page of a resume to identify its section boundaries
only — not to extract any data yet.

${buildBoundaryDetectionInstructions(previousPageContext)}`;
}

function isValidBoundaryResult(x: unknown): x is BoundaryResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.sections) && o.sections.every((s) =>
    s && typeof s === "object" && typeof (s as Record<string, unknown>).heading === "string" &&
    typeof (s as Record<string, unknown>).category === "string"
  );
}

// Real bug, found and root-caused via a direct re-probe during this same investigation (2026-09-18):
// when the boundary-detection call (step 1) is asked to categorize a headerless page-opening section
// it itself recognizes as a continuation of the previous page, it doesn't reliably re-derive the
// correct category from the continuation-context description in its own prompt — confirmed live,
// returning {heading: "", category: "unknown", is_continuation_of_previous_page: true} for a section
// that was plainly a work_history continuation (per previousPageContext.kind). When that happens, step
// 2's prompt ends up holding two CONTRADICTORY instructions for the same content in the same
// completion: the section-boundary block (built from step 1's "unknown") says route it to
// needs_review, while the separate, unmodified continuation-context block (built straight from
// previousPageContext, describeTrailingItem's own deterministic output) says it's a work_history
// continuation and must NOT go to needs_review — the exact "two competing signals in one completion"
// shape this whole redesign exists to eliminate, just reintroduced at a new seam. Confirmed live: the
// content was lost, landing in neither work_history nor any needs_review row — worse than the
// pre-Decision-38 misattribution pattern, which at least preserved it somewhere.
//
// The fix is structural, not more prose: we already know with certainty what kind of item is open
// (previousPageContext was built deterministically by describeTrailingItem from the actual previous
// page's own extraction) — there is no reason to ask the model to re-derive that same fact via a
// separate, unreliable judgment call. When step 1 itself claims a section is a headerless continuation
// (heading === "" && is_continuation_of_previous_page === true), its category is overridden here,
// in code, from previousPageContext directly — removing the model's redundant re-derivation removes
// the chance of it disagreeing with the continuation-context block it's also being handed. Scoped
// tightly to exactly this one condition; a section step 1 does NOT itself flag as a headerless
// continuation is left untouched, since that's a different, unrelated judgment this fix isn't about.
function resolveContinuationCategory(boundaries: BoundaryResult, previousPageContext?: TrailingItemContext | null): BoundaryResult {
  if (!previousPageContext || boundaries.sections.length === 0) return boundaries;
  const first = boundaries.sections[0];
  if (first.heading !== "" || !first.is_continuation_of_previous_page) return boundaries;

  let resolvedCategory: BoundaryCategory | null = null;
  if (previousPageContext.kind === "work_history") {
    resolvedCategory = "work_history";
  } else if (previousPageContext.kind === "certifications_list") {
    resolvedCategory = "certifications";
  } else if (previousPageContext.kind === "freeform") {
    // "needs_review" has no matching known category — leaving it "unknown" is already correct,
    // since step 2's own rules route "unknown" straight to needs_review, no contradiction possible.
    if (previousPageContext.sectionType === "summary") resolvedCategory = "summary";
    else if (previousPageContext.sectionType === "hobbies_other") resolvedCategory = "hobbies_other";
  }
  if (resolvedCategory === null || first.category === resolvedCategory) return boundaries;

  const sections = boundaries.sections.slice();
  sections[0] = { ...first, category: resolvedCategory };
  return { sections };
}

// STEP 2 OF 2 support: renders step 1's already-decided boundaries into the block step 2's prompt
// includes — this is what actually enforces "do not independently re-judge category", the same way
// buildContinuationContext's block below enforces continuation behavior. Kept separate from that
// function (rather than merged into one mega-block) because the two are conceptually independent
// inputs to step 2 — continuation state describes an OPEN item crossing a page boundary, section
// boundaries describe everything on THIS page including brand-new sections with no continuation at
// all — a page can have either, both, or neither.
function buildSectionBoundaryBlock(boundaries?: BoundaryResult | null): string {
  // Degraded-mode fallback: the boundary-detection step (a separate API call) failed or was never
  // attempted — see the handler's own try/catch around it. Rather than leave this call with no
  // classification guidance at all (the section-driven rules above are otherwise silent on what to do
  // when no boundaries were decided), explicitly hand back the old, pre-Decision-38 shape-based
  // per-item judgment as a whole-page fallback for THIS call only — a real degradation, not silent,
  // logged server-side when it happens, but never a reason to fail the whole page over one optional
  // call's failure.
  if (!boundaries) {
    return `

SECTION BOUNDARIES FOR THIS PAGE: none available (the boundary-detection step failed or was skipped).
Fall back to judging each section's category by its own heading, matched semantically (not by exact
wording) against the known internal categories — "Experience"/"Work History"/"Professional
Experience"/"Employment History" and similar = work_history; "Education"/"Academic Background" and
similar = education; "Certifications"/"Licenses"/"Credentials" and similar = certifications (licenses
and certifications are the SAME internal category, never split into two); "Skills"/"Core
Competencies"/"Technical Skills"/"Areas of Expertise" and similar = skills; "Summary"/"Objective"/
"About Me" and similar = summary; "Interests"/"Hobbies"/"Volunteer Work" and similar = hobbies_other.
For genuinely headerless content, fall back further to judging by its own shape — the same fallback
described in "THE ONE EXCEPTION" above, just applied to the whole page rather than one flagged
section, since no per-section decision exists this time. A header that matches none of the above goes
to needs_review, same as always.`;
  }
  if (boundaries.sections.length === 0) return "";
  const known = boundaries.sections.filter((s) => s.category !== "unknown");
  const unknown = boundaries.sections.filter((s) => s.category === "unknown");
  // Multiple distinct "skills" sections on THIS page (2026-09-23): decided HERE, deterministically,
  // same philosophy as the rest of this block — scoped to this page only, since previousPageContext
  // has no "skills" kind to reliably know whether an earlier page already had one.
  let sawSkills = false;
  const knownList = known.length
    ? known.map((s) => {
        const cont = s.is_continuation_of_previous_page ? " (continuation of the previous page's open item — see continuation context above)" : "";
        if (s.category === "skills") {
          if (sawSkills) {
            return `  - "${s.heading || "(no heading — continuation)"}" -> skills${cont}, BUT this is a SECOND (or
    later) skills-shaped section on THIS PAGE — a section already assigned "skills" above came first.
    Do NOT add this section's terms to the "skills" array; the "skills" array holds only the FIRST
    skills section's terms. Instead extract this section as ONE "freeform" entry: section_type
    "skills_secondary", "heading" set to "${s.heading || ""}" verbatim, "content" holding its terms
    exactly as the source presents them (comma-separated, one per line, however the source actually
    lists them — copied verbatim, not reformatted into a different list style).`;
          }
          sawSkills = true;
        }
        return `  - "${s.heading || "(no heading — continuation)"}" -> ${s.category}${cont}`;
      }).join("\n")
    : "  (none)";
  const unknownList = unknown.length
    ? unknown.map((s) => `  - "${s.heading || "(no heading at all)"}"`).join("\n")
    : "  (none)";

  return `

SECTION BOUNDARIES FOR THIS PAGE (already decided in a separate step — do not independently re-judge
any section's category by its content's shape, wording, or item count; the category below is final):
${knownList}
Every item under one of the sections above gets that section's category, no exceptions and no
re-litigating it against the category definitions below by shape — those definitions now describe how
to extract fields correctly WITHIN an already-assigned category (heading capture, line breaks, license
numbers, and so on), not how to decide the category itself.

SECTIONS WITH NO MATCHING KNOWN CATEGORY ("unknown" — real content, not a failure):
${unknownList}
Extract each of these as one or more "needs_review" freeform entries, heading set to that section's own
literal text verbatim, content holding everything under it. One narrow exception — see the CERT/LICENSE
VS. SKILL DISAMBIGUATION rule below: an "unknown" section that itself shows a genuine mix of items
with/without a discernible trailing certification/license number may still split some of its items into
certifications vs. skills using that signal. This is the ONLY place that item-level heuristic is allowed
to fire — never inside a section already assigned a real category above.`;
}

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
function buildContinuationContext(ctx?: TrailingItemContext | null): string {
  if (!ctx) return "";

  const preamble = `

CONTEXT FROM THE PREVIOUS PAGE (informational only — you are still extracting ONLY what's visible on
THIS page's image/text; use this only to correctly attribute genuine continuations, never to invent
content that isn't actually here). The previous page ended mid-way through the item described below,
and its status as "finished" or "still open" was NOT resolvable from that page alone — only THIS
page's own content can tell you which it was. A continuation legitimately never repeats its header —
do not require a repeated company/title/heading before treating this page's opening content as
belonging to it.`;

  // Kind-specific directive: each branch names the exact failure this is meant to close (see the
  // TrailingItemContext comment above for the study this is grounded in) rather than one generic
  // instruction covering all three shapes.
  let directive: string;
  if (ctx.kind === "work_history") {
    directive = `
The open item was a work-history entry at company "${ctx.company || "(unnamed)"}", title "${ctx.title || "(unnamed)"}"${ctx.heading ? ` under the literal heading "${ctx.heading}"` : ""}, whose visible responsibilities ended with: "...${ctx.snippet}"
If THIS page's content opens with bullet points that read as job responsibilities — not preceded by
a new job title, company name, or section heading — those bullets belong to THIS SAME job. Extract
them as a work_history entry with company="${ctx.company || ""}" and title="${ctx.title || ""}" (copied
verbatim, not reworded) so they can be merged with the previous page's entry automatically. Leave
"heading" blank on this continuation row — a continuation never repeats the section heading, and the
merge step keeps the first page's own heading value. Do NOT place them in freeform/needs_review, do
NOT leave company/title blank, and do NOT drop them because the job's own header isn't repeated on
this page — that header is never expected to repeat.`;
  } else if (ctx.kind === "certifications_list") {
    directive = `
The open item was a certifications list${ctx.heading ? ` under the literal heading "${ctx.heading}"` : ""}, whose last visible entry on the previous page was "${ctx.name || "(unnamed)"}"${ctx.issuingBody ? ` (issuing_body: "${ctx.issuingBody}")` : ""}.
If THIS page's opening content matches that same short "name (issuer)" list-item pattern, with
literally no heading of any kind between the previous item and this one, extract those as normal
certifications entries, not freeform — a list continuing across a page break is still one list. Set
heading="${ctx.heading || ""}" (copied verbatim, not reworded) for them too, same as issuing_body
below, so the merged list reports one consistent heading across the page break.
Unless this page's own content plainly states a DIFFERENT issuing body for one of those specific
items, set issuing_body="${ctx.issuingBody || ""}" for them too: a shared issuing body printed once
governs every item in the list it belongs to, not just the entries nearest to where it happens to be
printed.
HARD STOP CONDITION (a real, confirmed failure mode — read this carefully): the instant ANY new
heading appears on this page — including one that also names certifications, credentials, or a
similar-sounding concept, e.g. a "Professional Certifications" heading following a "Coursiv" list —
that heading starts a brand-new, separate list, with its own new "heading" value captured verbatim
(never "${ctx.heading || "the previous heading"}", never carried forward). Compare what you actually
see printed at the top of this page's content against the previous heading quoted above: if it's a
literally different string (even one that still names certifications generally), that difference IS
the hard stop signal — do NOT carry the previous list's issuing_body OR heading onto items under it,
and do NOT keep treating items under it as more of the previous list. A shared TOPIC two lists happen
to both fall under (e.g. both being certifications) is never a reason to merge them into one
continuing list — only a page break with the exact same heading string, or literally no heading at
all, in between is. Reproduced live: a real run treated a page's second, separately-headed
certifications list as an unbroken continuation of the first, wrongly inheriting its issuing_body AND
corrupting that second list's own item count in the process — judge every item strictly by whether a
DIFFERENT heading string appeared before it on THIS page, never by whether that heading is topically
similar to the previous list's.`;
  } else {
    directive = `
The open item was a freeform section${ctx.heading ? ` titled "${ctx.heading}"` : " with no visible heading"} (type: ${ctx.sectionType || "unknown"}), whose visible content ended with: "...${ctx.snippet}"
If THIS page's opening content plainly continues that — same tone/topic, appearing before any new
heading — extract it as a continuation of that same section: heading="${ctx.heading || ""}",
section_type="${ctx.sectionType || "needs_review"}" (copied verbatim, not reworded), rather than
inventing a new, separately-headed needs_review entry for it.`;
  }

  return `${preamble}
${directive}
If this page's opening content is clearly unrelated, or introduces its own new visible heading,
treat it as entirely separate, exactly as you would any other content on the page. But if you are
genuinely unsure whether it's a continuation or something new, prefer extracting it as the
continuation described above over silently omitting it or leaving it ambiguously classified — losing
real content is worse than a borderline attribution call.`;
}

function buildVisionExtractionPrompt(previousPageContext?: TrailingItemContext | null, sectionBoundaries?: BoundaryResult | null): string {
  return `You are extracting structured data directly from the attached image of one page of a resume. Read the document as printed — do not invent information that is not actually present in the image in some recognizable form. This may be one page of a multi-page resume; only extract what is actually visible on this page.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${SCHEMA_SHAPE}

${FIELD_DEFINITIONS}
  If the resume shows language proficiency as icons, bars, dots, or other non-text graphics rather
  than words, describe what you can determine from the graphic (e.g. the language name and an
  approximate level like "native/fluent/conversational/basic" if the graphic clearly conveys a
  level) in a "summary" or "hobbies_other" freeform entry — do not silently drop it, and do not
  invent a precision level the graphic doesn't actually convey.

${DATE_RULES}${buildContinuationContext(previousPageContext)}${buildSectionBoundaryBlock(sectionBoundaries)}`;
}

function buildOcrExtractionPrompt(ocrText: string, previousPageContext?: TrailingItemContext | null, sectionBoundaries?: BoundaryResult | null): string {
  return `You are extracting structured data from the raw OCR text of one page of a resume. The OCR
text below may contain recognition errors (misread characters, words glued together, minor
garbling) — do your best to read through that, but do not invent information that is not actually
present in the text in some recognizable form. This may be one page of a multi-page resume; only
extract what is actually present in this text.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${SCHEMA_SHAPE}

${FIELD_DEFINITIONS}

${DATE_RULES}${buildContinuationContext(previousPageContext)}${buildSectionBoundaryBlock(sectionBoundaries)}

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
}

// Structured continuation state threaded from the PREVIOUS page's own extraction (built by
// upload-resume's describeTrailingItem, kept in sync by hand here same as ExtractionResult itself).
// Replaces an earlier plain-English one-line description: 2026-09-14's N=9 same-document repro study
// found page-boundary-spanning content fails 11-44% of the time (either mis-landing in a headingless
// freeform block, or — in the majority of failures — vanishing entirely, not even reaching
// needs_review) while single-page content was 100% reliable across all 9 runs. A free-text blurb left
// too much interpretation up to this page's own model call; explicit fields + a kind-specific,
// directive instruction (below) is the fix actually being tried, not a further prose tweak.
type TrailingItemContext = {
  kind: "work_history" | "certifications_list" | "freeform";
  company?: string;
  title?: string;
  name?: string;
  heading?: string;
  sectionType?: string;
  issuingBody?: string;
  snippet: string;
};

type ExtractionResult = {
  candidate_location?: string;
  printed_header?: string;
  work_history: Array<{ company: string; title: string; location?: string; start_date: string; end_date: string; job_responsibilities: string; extraction_confidence: string; position?: number; heading?: string }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; location?: string; start_date: string; end_date: string; extraction_confidence: string; position?: number; heading?: string }>;
  certifications: Array<{ name: string; issuing_body: string; license_number?: string; issue_date: string; expiration_date: string; extraction_confidence: string; position?: number; heading?: string }>;
  skills: Array<string>;
  skills_heading?: string;
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

// STEP 1 OF 2 execution: cheap, small-output call — no item extraction happens here, so max_tokens
// stays far below the full-extraction calls below. Same model per modality as step 2 (Sonnet for
// vision, Haiku for OCR text) for consistency; temperature:0 on the Haiku variant for the same reason
// step 2's Haiku call already runs at temperature:0 (see that function's own comment) — Sonnet still
// rejects the parameter outright under adaptive thinking, unchanged from step 2's existing constraint.
// Every Anthropic call goes through here so each one is timed and bounded. The bound is real, not cosmetic:
// before this, a stalled model call had no ceiling of its own and simply ran into the platform's ~150 s kill,
// taking the whole page (and, for a caller that awaits sequentially, the whole upload) with it. The per-call
// numbers are returned to the caller in the page response (model_calls) so where a page's time actually went is
// recorded, not inferred.
type CallStat = { step: string; model: string; ms: number; input_tokens?: number; output_tokens?: number; stop_reason?: string; thinking_blocks?: number; error?: string };
const BOUNDARY_CALL_TIMEOUT_MS = 45_000; // step 1 is a small-output call (2-12 s measured); a failure here degrades to the fallback, so fail fast
const EXTRACTION_CALL_TIMEOUT_MS = 100_000; // 30-47 s measured on Sonnet vision; leaves room inside the ~150 s platform limit

async function anthropicMessages(step: string, payload: Record<string, unknown>, timeoutMs: number, stats?: CallStat[]): Promise<any> {
  const start = Date.now();
  const model = String(payload.model);
  let claudeRes: Response;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === "TimeoutError";
    stats?.push({ step, model, ms: Date.now() - start, error: timedOut ? "timeout" : "network" });
    throw new Error(timedOut ? `claude_call_timeout (${step} after ${timeoutMs}ms)` : `claude_call_unreachable (${step}): ${String(e)}`);
  }
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    stats?.push({ step, model, ms: Date.now() - start, error: `http_${claudeRes.status}` });
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }
  let claudeData: any;
  try {
    claudeData = await claudeRes.json();
  } catch (e) {
    // The body stream is covered by the same signal: a response that starts and then stalls lands here.
    stats?.push({ step, model, ms: Date.now() - start, error: "body_timeout_or_malformed" });
    throw new Error(`claude_call_body_failed (${step}): ${String(e)}`);
  }
  stats?.push({
    step, model, ms: Date.now() - start,
    input_tokens: claudeData?.usage?.input_tokens, output_tokens: claudeData?.usage?.output_tokens, stop_reason: claudeData?.stop_reason,
    thinking_blocks: (claudeData?.content ?? []).filter((b: { type?: string }) => b.type === "thinking" || b.type === "redacted_thinking").length,
  });
  return claudeData;
}

async function runBoundaryDetectionVision(pngBase64: string, previousPageContext?: TrailingItemContext | null, stats?: CallStat[]): Promise<BoundaryResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeData = await anthropicMessages("boundary_vision", {
    model: VISION_MODEL,
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
        { type: "text", text: buildBoundaryDetectionPromptVision(previousPageContext) },
      ],
    }],
  }, BOUNDARY_CALL_TIMEOUT_MS, stats);
  const { parsed, parseError, rawText } = extractJsonFromClaudeResponse(claudeData);
  if (parseError) throw new Error(`malformed_boundary_vision_response: ${rawText.slice(0, 500)}`);
  if (!isValidBoundaryResult(parsed)) throw new Error("boundary_vision_response_wrong_shape");
  return parsed;
}

async function runBoundaryDetectionHaiku(ocrText: string, previousPageContext?: TrailingItemContext | null, stats?: CallStat[]): Promise<BoundaryResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeData = await anthropicMessages("boundary_haiku", {
    model: HAIKU_MODEL,
    max_tokens: 1024,
    temperature: 0,
    messages: [{ role: "user", content: buildBoundaryDetectionPromptText(ocrText, previousPageContext) }],
  }, BOUNDARY_CALL_TIMEOUT_MS, stats);
  const { parsed, parseError, rawText } = extractJsonFromClaudeResponse(claudeData);
  if (parseError) throw new Error(`malformed_boundary_haiku_response: ${rawText.slice(0, 500)}`);
  if (!isValidBoundaryResult(parsed)) throw new Error("boundary_haiku_response_wrong_shape");
  return parsed;
}

async function runVisionExtraction(pngBase64: string, previousPageContext?: TrailingItemContext | null, sectionBoundaries?: BoundaryResult | null, stats?: CallStat[]): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeData = await anthropicMessages("extraction_vision", {
    model: VISION_MODEL,
    max_tokens: 16000, // 8192 truncated real runs earlier tonight; 16000 didn't
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
        { type: "text", text: buildVisionExtractionPrompt(previousPageContext, sectionBoundaries) },
      ],
    }],
  }, EXTRACTION_CALL_TIMEOUT_MS, stats);
  const { parsed, parseError, rawText } = extractJsonFromClaudeResponse(claudeData);
  if (parseError) throw new Error(`malformed_vision_response: ${rawText.slice(0, 500)}`);
  if (!isValidExtraction(parsed)) throw new Error("vision_response_wrong_shape");
  return parsed;
}

async function runHaikuExtraction(ocrText: string, previousPageContext?: TrailingItemContext | null, sectionBoundaries?: BoundaryResult | null, stats?: CallStat[]): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeData = await anthropicMessages("extraction_haiku", {
      model: HAIKU_MODEL,
      max_tokens: 4096,
      // Non-determinism diagnostic (2026-09-17): a direct 58-call probe (15x per page x 4 pages,
      // identical byte-for-byte OCR input each time, confirmed via hash) found the raw OCR text
      // stage fully deterministic, with all observed variance living in this Haiku call's own
      // interpretation of that fixed input -- 3 of 4 pages showed stable item counts but varying
      // wording, 1 of 4 showed genuine count-level classification variance. temperature was never
      // set here (defaulting to the API's non-zero default), unlike extract-resume-fields' own
      // Haiku 4.5 call (same model) which already runs at temperature: 0 without issue -- proof
      // this model accepts it. Unlike Sonnet 5's vision call, Haiku 4.5 does not reject temperature
      // (no adaptive-thinking-forced restriction), so this is a real, low-risk lever, not a
      // guaranteed fix -- Claude models don't guarantee bit-identical output at temperature 0 either.
      temperature: 0,
      messages: [{ role: "user", content: buildOcrExtractionPrompt(ocrText, previousPageContext, sectionBoundaries) }],
  }, EXTRACTION_CALL_TIMEOUT_MS, stats);
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

// STRIP OCR (2026-09-19). Supabase kills an Edge Function invocation after ~2 s of CPU time (surfaces as
// WORKER_RESOURCE_LIMIT). tesseract-wasm costs ~5.5 ms per recognised word on the platform (measured: a 217-244 word
// strip takes 1.3-1.5 s; the ~600-word full page of a real resume and even a ~350-word half are killed, at 150 AND
// 110 DPI), so a dense page could never finish OCR inside one invocation, and every such page fell through to the
// Sonnet-vision route (~45-75 s per page instead of ~7 s). Instead of OCR-ing the whole page here, a dense page is cut
// into horizontal strips that each fit the budget and each strip is OCR'd by its own ocr-page-strip invocation, in
// parallel; the word boxes are merged and go through the SAME word clustering and Haiku steps as before.
//
// Cuts are always in the blank rows BETWEEN text lines (a line is never split), chosen from the page's row ink profile.
// A strip is closed when it holds OCR_MAX_LINES_PER_STRIP lines or OCR_INK_BUDGET_150DPI dark pixels (ink tracks glyph
// count whatever the layout: measured 236-307 px per word at 150 DPI on 10 pt text, so 22,000 px ~ 70-90 words).
// The budget is deliberately small because the platform's CPU speed is NOT steady: identical strips of ~170 words were
// measured passing (0.86 s to recognise) and then being killed on a repeat call minutes later, and 81-word strips took
// as long as 171-word ones had, i.e. ~2x swings over time. A strip therefore needs ~2.5x headroom under the 2 s limit,
// not an average-case fit. As a second line of defence a strip that is still killed is split in half at a blank row and
// retried (see ocrRowsAdaptive). A page that fits in one strip is OCR'd in-process exactly as before, so sparse pages
// are unchanged. Measured against the PDF's exact text layer, strips match whole-page OCR
// word for word (563/594 both ways on page 1), so the split costs no accuracy.
const OCR_MAX_LINES_PER_STRIP = 8;
const OCR_INK_BUDGET_150DPI = 22_000;
const OCR_MAX_STRIPS = 12; // also bounded by the platform's per-trace relay limit (30 nested function calls per minute; see upload-resume)
const OCR_MIN_SPLIT_ROWS = 120; // a strip shorter than this is not split further, only retried
const OCR_STRIP_TIMEOUT_MS = 40_000;
const OCR_STRIP_FN_URL = `${SUPABASE_URL}/functions/v1/ocr-page-strip`;

function planOcrStrips(rgb: Uint8Array, width: number, height: number, scale: number): { strips: Array<[number, number]>; rowInk: Uint32Array } {
  const inkBudget = OCR_INK_BUDGET_150DPI * Math.pow(scale / (150 / 72), 2);
  const rowInk = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    const o = y * width * 3;
    for (let x = 0; x < width; x++) if (rgb[o + x * 3] < 170) c++;
    rowInk[y] = c;
  }
  const bands: Array<{ start: number; end: number; ink: number }> = [];
  let start = -1, ink = 0;
  for (let y = 0; y <= height; y++) {
    if (y < height && rowInk[y] > 0) { if (start < 0) start = y; ink += rowInk[y]; }
    else if (start >= 0) { bands.push({ start, end: y, ink }); start = -1; ink = 0; }
  }
  if (bands.length <= 1) return { strips: [[0, height]], rowInk };
  const strips: Array<[number, number]> = [];
  let stripStart = 0, lines = 0, stripInk = 0, prevLines = 0;
  for (let i = 0; i < bands.length; i++) {
    if (lines > 0 && (lines >= OCR_MAX_LINES_PER_STRIP || stripInk + bands[i].ink > inkBudget)) {
      const cut = Math.round((bands[i - 1].end + bands[i].start) / 2); // middle of the blank gap between two lines
      strips.push([stripStart, cut]);
      stripStart = cut; prevLines = lines; lines = 0; stripInk = 0;
    }
    lines++; stripInk += bands[i].ink;
  }
  // A last strip of one or two lines (a footer, a page number) is not worth its own invocation: fold it into the previous one.
  if (lines <= 2 && strips.length > 0 && prevLines + lines <= OCR_MAX_LINES_PER_STRIP + 2) {
    strips[strips.length - 1] = [strips[strips.length - 1][0], height];
  } else {
    strips.push([stripStart, height]);
  }
  return { strips, rowInk };
}

// Nearest fully blank row to the middle of [y0, y1) that leaves at least 30 rows on each side, or null.
function findBlankRowNear(rowInk: Uint32Array, y0: number, y1: number): number | null {
  const mid = Math.round((y0 + y1) / 2);
  for (let d = 0; d <= (y1 - y0) / 2 - 30; d++) {
    if (rowInk[mid + d] === 0) return mid + d;
    if (rowInk[mid - d] === 0) return mid - d;
  }
  return null;
}

type StripResult = { words: TextItem[]; rows: [number, number]; timing_ms: unknown; attempts: number };

async function callOcrStrip(storagePath: string, pageNum: number, scale: number, width: number, y0: number, y1: number): Promise<{ words: TextItem[]; timing_ms: unknown }> {
  let lastErr = "unknown";
  try {
    const res = await fetch(OCR_STRIP_FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ storage_path: storagePath, page_number: pageNum, scale, width, y0, y1 }),
      signal: AbortSignal.timeout(OCR_STRIP_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && Array.isArray(data.words)) return { words: data.words as TextItem[], timing_ms: data.timing_ms };
    lastErr = `http_${res.status} ${data.code || data.error || ""}`.trim();
  } catch (e) {
    lastErr = String(e);
  }
  throw new Error(`ocr_strip_failed (rows ${y0}-${y1}): ${lastErr}`);
}

// One strip, with recovery: a strip is a fresh, independent invocation, so a kill is often transient. On failure a
// tall strip is split at a blank row and both halves retried (depth-limited); a short one is simply retried once.
async function ocrRowsAdaptive(storagePath: string, pageNum: number, scale: number, width: number, y0: number, y1: number, rowInk: Uint32Array, depth: number): Promise<StripResult[]> {
  try {
    const r = await callOcrStrip(storagePath, pageNum, scale, width, y0, y1);
    return [{ words: r.words, rows: [y0, y1], timing_ms: r.timing_ms, attempts: 1 }];
  } catch (firstErr) {
    const cut = y1 - y0 >= OCR_MIN_SPLIT_ROWS && depth < 2 ? findBlankRowNear(rowInk, y0, y1) : null;
    if (cut !== null) {
      const halves = await Promise.all([
        ocrRowsAdaptive(storagePath, pageNum, scale, width, y0, cut, rowInk, depth + 1),
        ocrRowsAdaptive(storagePath, pageNum, scale, width, cut, y1, rowInk, depth + 1),
      ]);
      return halves.flat().map((h) => ({ ...h, attempts: h.attempts + 1 }));
    }
    const r = await callOcrStrip(storagePath, pageNum, scale, width, y0, y1); // last resort: same rows once more (throws if it fails)
    return [{ words: r.words, rows: [y0, y1], timing_ms: r.timing_ms, attempts: 2 }];
  }
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

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (staff/internal endpoint auth pass, 2026-09-19).
// This function used to have no caller check beyond the platform's own key check, which the PUBLIC anon key (embedded in
// candidate.html and staff.html) passes: anyone could call it. It now requires one of:
//   * the service-role key as the bearer token (what our own functions send when they call each other; exact match,
//     constant-time compare), which is the only caller this function has (upload-resume); or
//   * a live STAFF session: the staff_session_token staff.html already holds from staff-confirm-login, checked on every call
//     against staff_sessions (hashed, unrevoked, unexpired) and resolved to a staff_users row. Identity is never taken from
//     the request body.
// Anything else is the same 401 whether the token was missing, wrong, expired or revoked.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type AuthCaller = { kind: "service" } | { kind: "staff"; id: string; email: string; name: string; role: string };
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function authSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function authenticateStaffOrService(req: Request, body: any, allow: { staff: boolean; service: boolean }): Promise<AuthCaller | null> {
  if (allow.service) {
    const h = req.headers.get("authorization") || "";
    const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (t && AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY)) return { kind: "service" };
  }
  if (allow.staff) {
    const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
    if (tok.length >= 20 && tok.length <= 200) {
      const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
      const sRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: rest });
      const sess = sRes.ok ? (await sRes.json())[0] : null;
      if (sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now()) {
        const uRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`, { headers: rest });
        const u = uRes.ok ? (await uRes.json())[0] : null;
        if (u) return { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role };
      }
    }
  }
  return null;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    let authBody: any = {};
    try { authBody = await req.clone().json(); } catch (_e) { authBody = {}; }
    const caller = await authenticateStaffOrService(req, authBody, { staff: false, service: true });
    if (!caller) return UNAUTHORIZED();
    try {
      const { storage_path, page_number, target_dpi, force_vision, previous_page_context } = await req.json();
      if (!storage_path || typeof storage_path !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "storage_path_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const pageNum = Number(page_number) || 1; // 1-indexed
      const dpi = Number(target_dpi) || 150;
      // Wire format is now a structured object (see TrailingItemContext) rather than a plain string —
      // validate defensively rather than trust the caller, same posture as storage_path/page_number
      // above; a malformed value is simply treated as "no continuation context" rather than a 400,
      // since it's optional and this page's own extraction can still proceed correctly without it.
      const trailingContext: TrailingItemContext | null =
        previous_page_context && typeof previous_page_context === "object" &&
        typeof previous_page_context.kind === "string" && typeof previous_page_context.snippet === "string"
          ? previous_page_context as TrailingItemContext
          : null;

      const handlerStart = Date.now();
      const modelCalls: CallStat[] = []; // one entry per Anthropic call this page made (timing/tokens/stop reason)
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
      let ocrStripCount = 0;
      let ocrStripTiming: unknown = undefined;

      // STEP 1 OF 2 (Decision 38): section-boundary detection, one extra call before the real
      // extraction call below, on whichever input this page's routing already picked (image for
      // vision, OCR text for tesseract — tesseract has to run first on that path, so boundary
      // detection sits after it and before extraction there, not before both branches). Wrapped in
      // its own try/catch and never allowed to fail the page — a genuine accuracy improvement over
      // the old one-call design, not a new hard dependency; on failure, buildSectionBoundaryBlock's
      // own null-boundaries branch hands step 2 the old, pre-Decision-38 shape-based fallback
      // instead, so a transient failure here degrades to yesterday's behavior for this one page
      // rather than failing the whole upload.
      let sectionBoundaries: BoundaryResult | null = null;
      let boundaryMs: number | undefined;

      if (useVision) {
        try {
          const boundaryStart = Date.now();
          sectionBoundaries = resolveContinuationCategory(await runBoundaryDetectionVision(bytesToB64(pngBytes), trailingContext, modelCalls), trailingContext);
          boundaryMs = Date.now() - boundaryStart;
        } catch (boundaryErr) {
          console.log(`rasterize-pdf-page: boundary detection failed, falling back to shape-based classification for this page — ${String(boundaryErr)}`);
        }
        const visionStart = Date.now();
        extraction = await runVisionExtraction(bytesToB64(pngBytes), trailingContext, sectionBoundaries, modelCalls);
        extractionMs = Date.now() - visionStart;
      } else {
        const ocrStart = Date.now();
        const rgb = pixmap.getPixels(); // raw RGB Uint8Array (3 bytes/pixel) — no alpha, per above
        const { strips: stripPlan, rowInk } = planOcrStrips(rgb, renderedWidth, renderedHeight, scale);
        ocrStripCount = stripPlan.length;
        if (stripPlan.length <= 1) {
          const rgba = rgbToRgba(rgb);
          ocrText = await runTesseract(rgba, renderedWidth, renderedHeight);
        } else {
          try {
            if (stripPlan.length > OCR_MAX_STRIPS) throw new Error(`ocr_too_many_strips (${stripPlan.length})`);
            const parts = (await Promise.all(stripPlan.map(([a, b]) => ocrRowsAdaptive(storage_path, pageNum, scale, renderedWidth, a, b, rowInk, 0)))).flat();
            ocrStripTiming = parts.map((pt) => ({ rows: pt.rows, words: pt.words.length, attempts: pt.attempts, timing_ms: pt.timing_ms }));
            ocrText = reconstructByWordClustering(parts.flatMap((pt) => pt.words));
          } catch (stripErr) {
            // Reported with the same code the caller's retry ladder already keys on (WORKER_RESOURCE_LIMIT): this page
            // cannot be OCR'd within the platform's CPU limit, so the ladder retries once at a lower DPI and finally
            // routes it to the vision extraction (force_vision), exactly as for an in-process crash before.
            return new Response(JSON.stringify({ ok: false, code: "WORKER_RESOURCE_LIMIT", error: "ocr_strips_failed", detail: String(stripErr), ocr_strips: { count: stripPlan.length } }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        ocrMs = Date.now() - ocrStart;
        try {
          const boundaryStart = Date.now();
          sectionBoundaries = resolveContinuationCategory(await runBoundaryDetectionHaiku(ocrText, trailingContext, modelCalls), trailingContext);
          boundaryMs = Date.now() - boundaryStart;
        } catch (boundaryErr) {
          console.log(`rasterize-pdf-page: boundary detection failed, falling back to shape-based classification for this page — ${String(boundaryErr)}`);
        }
        const haikuStart = Date.now();
        extraction = await runHaikuExtraction(ocrText, trailingContext, sectionBoundaries, modelCalls);
        extractionMs = Date.now() - haikuStart;
      }
      extraction.skills_heading = resolveSkillsHeading(sectionBoundaries, extraction);

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
        section_boundaries: sectionBoundaries,
        ocr_raw_text: ocrText,
        timing_ms: { fetch: fetchMs, import: importMs, open: openMs, render: renderMs, ocr: ocrMs, boundary: boundaryMs, extraction: extractionMs, total: Date.now() - handlerStart },
        model_calls: modelCalls,
        ocr_strips: { count: ocrStripCount, strips: ocrStripTiming },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
