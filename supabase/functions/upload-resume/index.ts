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
// STEP 1 OF 2: SECTION-BOUNDARY DETECTION — Decision 38 (2026-09-18), mirrored here from
// rasterize-pdf-page/index.ts (see that file's own header comment for the full root-cause story —
// this is the same fix, not a fresh design, applied to this function's single-call, single-image
// shape). No continuation-context concept exists in this function (one image, one call, no page
// boundaries) — that's the one structural difference from rasterize-pdf-page's copy of this same
// mechanism, everything else is identical in spirit.
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
- additional_info: real, commonly-seen resume content that doesn't correspond to any of the six
  categories above and isn't independently verifiable — the same non-verified status hobbies_other
  already has, just a different common shape. Covers headers like "Projects," "Portfolio," "AI
  Projects & Portfolio," "Career Highlights," "Selected Career Highlights," "Workplace Strengths,"
  "Achievements," "Professional Affiliations," "Awards," "Publications," "Languages," or similar —
  a real, distinct header naming one of these recognizable patterns, however worded. This is NOT a
  failure state and is NOT the same as "unknown" below: additional_info content is delivered on the
  resume by default (the same as hobbies_other), never silently paywalled, because it is a
  recognized, common section type, not a genuinely unclassifiable one.
2026-09-23 addition (real, confirmed gap): content this common was previously being sent to
"unknown"/needs_review purely because it didn't match one of the ORIGINAL six categories above — that
silently excluded real, substantial resume content (a candidate's own listed projects, differentiator
highlights, professional affiliations) from their generated resume by default, with no way for a
free-tier candidate to ever recover it. additional_info exists specifically to stop that: match a
header against this list BEFORE falling through to "unknown".
If a section's header STILL doesn't semantically match ANY of the seven categories above — a real
header exists, but names something else entirely and doesn't fit any recognizable common pattern
either — its category is "unknown". This is not a failure state either: "unknown" content is real,
gets captured in full, and is unconditionally flagged for a human to review (never silently dropped,
never forced into a category it doesn't belong in just to avoid "unknown") — this is the anti-gaming
design: a candidate cannot route real content around verification by mislabeling its own section
header as if it were work_history, education, certifications, or skills. additional_info does not
weaken this: it only ever applies to a header that clearly matches one of the common, professionally-
mundane patterns listed above, never to a header that could plausibly be an attempt to relabel
employment, a degree, a credential, or a skill list.`;

// Sub-entries inside a Projects/Portfolio-shaped section (2026-09-23), mirrored from
// extract-resume-fields/index.ts (see that file's own header comment for the full root-cause story —
// an "AI PROJECTS & PORTFOLIO" section listing 4 distinct projects, each with its own bold
// project-name line, a tool-stack + date line, and its own bullet(s), came back shattered into several
// disconnected sections instead of staying one, several losing their heading entirely because only the
// FIRST project's name was treated as the section's real heading).
const MULTI_ENTRY_SECTION_BOUNDARY_RULE = `MULTIPLE NAMED SUB-ENTRIES UNDER ONE SECTION (a narrow, structural exception, most relevant to
"Projects"/"Portfolio"-shaped sections but applicable to any section): once a real top-level heading has
opened a section, that section can legitimately contain SEVERAL parallel, individually-named sub-entries
under it — e.g. a "Projects" or "AI Projects & Portfolio" section listing several separate projects, each
with its own bold project-name line, its own secondary line (tools used, a date range), and its own
bullet(s) describing it. This is structurally the same pattern work_history sections already have (one
heading, several dated company/title entries under it) — treat it the same way: the section's own
top-level heading (e.g. "AI Projects & Portfolio") stays the ONE section boundary and category decision
for the WHOLE block; a subsequent project's own bold name line is part of that SAME section's content,
never a new section boundary of its own, even though it visually resembles a heading. Judge this
structurally: a short bold line immediately followed by a secondary line (tools/dates) and then
bullet(s), appearing after an already-open section with no unrelated topic shift, is a sub-entry of that
open section, not a new section — this holds no matter how many sub-entries follow one after another.
Only a line that is clearly a DIFFERENT, unrelated section's own heading (a genuinely new topic, e.g.
"PROFESSIONAL EXPERIENCE" appearing after a Projects section) ends the current section and starts a new
one.`;

type BoundaryCategory = "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "additional_info" | "unknown";

type BoundarySection = { heading: string; category: BoundaryCategory };

// noMergeCompanies / mergeCompanies (2026-09-23): a SAME COMPANY, MULTIPLE ROLES merge decision the
// main extraction step kept getting wrong even after three prose-only attempts at the "don't merge"
// direction. Adding noMergeCompanies alone then exposed the SAME unreliability from the other side: a
// genuine Shape-A case (one real header, one subordinate promotion note) stopped reliably reaching the
// merge step once left to the model's own prose gating test — the prose was never actually reliable,
// earlier tests just hadn't exposed it yet. Both directions decided HERE instead, deterministically —
// same philosophy as the rest of this block. A company appears in at most one of the two lists.
type BoundaryResult = { sections: BoundarySection[]; noMergeCompanies?: string[]; mergeCompanies?: string[] };

const BOUNDARY_SCHEMA_SHAPE = `{
  "sections": [
    { "heading": string, "category": "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "additional_info" | "unknown" }
  ],
  "noMergeCompanies": [ string ],
  "mergeCompanies": [ string ]
}`;

function buildBoundaryDetectionPrompt(): string {
  return `You are analyzing the attached image of a resume to identify its section boundaries only —
not to extract any data yet.

Identify every distinct SECTION in this document and assign each one a category — nothing else, at
this step. A section is a heading plus everything under it up to the next heading (or the end of the
document). If the document (or its opening portion, before any first heading) has real content with NO
heading at all governing it, that is still one section — heading="" — do not guess a category for it
based on its content's shape; give it category "unknown" here (step 2 of this pipeline has its own,
separate shape-based fallback for genuinely headerless content — resolving that is not this step's job).

Do NOT read, extract, or judge individual items inside any section at this step — you are drawing
boundaries and matching header MEANING only. Nothing about what's inside a section (its shape, its item
count, whether individual items look like one category or another) should influence its category here.
Two sections can share the same broad topic (e.g. two different certifications-style headings) and
still be two separate sections if they have two separate, distinct heading strings — never merge them
into one just because they're topically similar; a genuinely different heading string always starts a
new section.

${KNOWN_CATEGORIES_GUIDE}

A SEPARATE TASK, after boundaries — SAME-COMPANY, MULTIPLE ROLES: decide, for every employer name that
appears more than once within whatever section(s) you judged as work_history above, whether it must
merge into one work_history entry or stay as separate entries. Do NOT leave this decision to a later
step — decide it definitively here, for every repeated company, so nothing is left ambiguous.

The test: count the COMPLETE header lines naming this company. A complete header line is one that, by
itself, states a title, this company, AND a date range (the same header shape the document uses for
every other employer entry) — not a parenthetical or a subordinate aside underneath a single shared
header.
  - Exactly ONE complete header line names this company, with any other role for it mentioned ONLY as
    a subordinate aside UNDER that one header (a parenthetical, an italicized note, a short line like
    "Promoted mid-year from Desktop Publishing Manager (1996-1997)" that has no company/location/date-
    range fields of its own) → list the company's exact printed name in "mergeCompanies". This is a
    genuine internal promotion/title-change within one tenure.
  - TWO OR MORE complete header lines independently name this company, each with its own title AND its
    own date range → list the company's exact printed name in "noMergeCompanies", regardless of
    whether the roles read like an internal promotion or carry a caption such as "Role transition" or
    "Promoted from...". A caption on one header never erases the fact that the other role has its own
    separate, complete header elsewhere.
  - The company's two mentions read as genuinely separate, disconnected stints with an unrelated gap
    (not a continuous tenure at all) → list it in neither array; leave it out entirely.
A company appears in at most one of the two arrays, never both. When no company repeats at all, return
two empty arrays.

Two confirmed real examples to calibrate against precisely (get this test wrong in either direction
and downstream data is wrong): "Business Education Teacher | School District of Indian River County |
Sebastian, FL | 2018 - 2025" and "Associate Dean of Discipline | School District of Indian River
County | Sebastian, FL | 2025 - 2026" are TWO complete header lines (each independently states its own
title, company, location, AND date range) — list "School District of Indian River County" in
"noMergeCompanies". By contrast, "Manager of Business Analysis and Publishing Systems | Thomson
Reuters | Montvale, NJ | 1996 - 1998" followed on its own line by "Promoted mid-year from Desktop
Publishing Manager (1996-1997)" is only ONE complete header line — the second line names an earlier
title but has no company, no location, and no independent date range of its own printed on it (the
"(1996-1997)" is a parenthetical aside inside that one sentence, not a standalone date-range field
like the header line has) — list "Thomson Reuters" in "mergeCompanies". The test is whether the SECOND
mention independently repeats the company name AND prints its own location AND its own date range as
separate fields the way the first one does, not whether it names an earlier title at all.

${MULTI_ENTRY_SECTION_BOUNDARY_RULE}

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

${BOUNDARY_SCHEMA_SHAPE}`;
}

function isValidBoundaryResult(x: unknown): x is BoundaryResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.noMergeCompanies !== undefined && !(Array.isArray(o.noMergeCompanies) && o.noMergeCompanies.every((c) => typeof c === "string"))) return false;
  if (o.mergeCompanies !== undefined && !(Array.isArray(o.mergeCompanies) && o.mergeCompanies.every((c) => typeof c === "string"))) return false;
  return Array.isArray(o.sections) && o.sections.every((s) =>
    s && typeof s === "object" && typeof (s as Record<string, unknown>).heading === "string" &&
    typeof (s as Record<string, unknown>).category === "string"
  );
}

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

// STEP 2 OF 2 support: renders step 1's already-decided boundaries into the block step 2's prompt
// includes — this is what actually enforces "do not independently re-judge category". Mirrors
// rasterize-pdf-page's buildSectionBoundaryBlock exactly, minus the continuation-context branch,
// which doesn't apply to this function's single-call shape.
function buildSectionBoundaryBlock(boundaries?: BoundaryResult | null): string {
  if (!boundaries) {
    return `

SECTION BOUNDARIES: none available (the boundary-detection step failed or was skipped). Fall back to
judging each section's category by its own heading, matched semantically (not by exact wording)
against the known internal categories — "Experience"/"Work History"/"Professional Experience"/
"Employment History" and similar = work_history; "Education"/"Academic Background" and similar =
education; "Certifications"/"Licenses"/"Credentials" and similar = certifications (licenses and
certifications are the SAME internal category, never split into two); "Skills"/"Core Competencies"/
"Technical Skills"/"Areas of Expertise" and similar = skills; "Summary"/"Objective"/"About Me" and
similar = summary; "Interests"/"Hobbies"/"Volunteer Work" and similar = hobbies_other; "Projects"/
"Portfolio"/"Career Highlights"/"Workplace Strengths"/"Professional Affiliations"/"Awards"/
"Publications"/"Languages" and similar = additional_info (delivered by default, same as
hobbies_other). For genuinely headerless content, fall back further to judging by its own shape — the
same fallback described in "THE ONE EXCEPTION" above, just applied to the whole document rather than
one flagged section, since no per-section decision exists this time. A header that matches none of the
above goes to needs_review, same as always.`;
  }
  const noMergeCompanies = (boundaries.noMergeCompanies || []).filter((c) => typeof c === "string" && c.trim());
  const mergeCompanies = (boundaries.mergeCompanies || []).filter((c) => typeof c === "string" && c.trim());
  if (boundaries.sections.length === 0 && noMergeCompanies.length === 0 && mergeCompanies.length === 0) return "";
  const known = boundaries.sections.filter((s) => s.category !== "unknown");
  const unknown = boundaries.sections.filter((s) => s.category === "unknown");
  // Multiple distinct "skills" sections (2026-09-23): decided HERE, deterministically, same philosophy
  // as the rest of this block — not left as a prose rule the model has to notice and apply on its own
  // while it's busy extracting everything else. Only the first skills-category section stays "skills";
  // every later one is flagged explicitly, per section, as its own freeform "skills_secondary" entry.
  let sawSkills = false;
  const knownList = known.length
    ? known.map((s) => {
        if (s.category === "skills") {
          if (sawSkills) {
            return `  - "${s.heading || "(no heading)"}" -> skills, BUT this is a SECOND (or later) skills-shaped
    section on this document — a section already assigned "skills" above came first. Do NOT add this
    section's terms to the "skills" array; the "skills" array holds only the FIRST skills section's
    terms. Instead extract this section as ONE "freeform" entry: section_type "skills_secondary",
    "heading" set to "${s.heading || ""}" verbatim, "content" holding its terms exactly as the source
    presents them (comma-separated, one per line, however the source actually lists them — copied
    verbatim, not reformatted into a different list style).`;
          }
          sawSkills = true;
        }
        return `  - "${s.heading || "(no heading)"}" -> ${s.category}`;
      }).join("\n")
    : "  (none)";
  const unknownList = unknown.length
    ? unknown.map((s) => `  - "${s.heading || "(no heading at all)"}"`).join("\n")
    : "  (none)";
  // SAME COMPANY, MULTIPLE ROLES (2026-09-23): decided HERE too, both directions, same reasoning as
  // the skills_secondary case above. The merge-eligible direction turned out to need this just as much
  // as the don't-merge direction — see this file's own noMergeCompanies/mergeCompanies type comment
  // for the full story of why both are needed, not just one.
  const noMergeBlock = noMergeCompanies.length
    ? `

SAME COMPANY, MULTIPLE ROLES — ALREADY DECIDED, DO NOT MERGE THESE COMPANIES (do not run your own
gating test against them, do not merge them, no matter what caption or transition language is nearby):
the following employer names have two or more independent, complete header lines in this document —
each with its own title and its own date range — so each of THEIR header lines must be its own
separate work_history entry, keeping its own real title and its own real start_date/end_date exactly
as printed on that line:
${noMergeCompanies.map((c) => `  - "${c}"`).join("\n")}`
    : "";
  const mergeBlock = mergeCompanies.length
    ? `

SAME COMPANY, MULTIPLE ROLES — ALREADY DECIDED, MERGE THESE COMPANIES (do not run your own gating test
against them, go straight to the "HOW TO MERGE" mechanics below for each one — this IS a genuine
internal promotion/title-change within one tenure, already confirmed): the following employer names
have exactly one complete header line, with any other role for that same tenure mentioned only as a
subordinate aside underneath it — combine each into ONE work_history entry per the HOW TO MERGE steps
below (joined title, earliest start_date, latest end_date, full job_responsibilities including the
aside's own content):
${mergeCompanies.map((c) => `  - "${c}"`).join("\n")}`
    : "";
  const sameCompanyFooter = (noMergeBlock || mergeBlock)
    ? `
Any OTHER company name not listed in either block above that still repeats follows the ordinary SAME
COMPANY, MULTIPLE ROLES rules below as normal (run the gating test yourself for those only).`
    : "";

  return `

SECTION BOUNDARIES FOR THIS DOCUMENT (already decided in a separate step — do not independently
re-judge any section's category by its content's shape, wording, or item count; the category below is
final):
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
to fire — never inside a section already assigned a real category above.${noMergeBlock}${mergeBlock}${sameCompanyFooter}`;
}

function buildVisionExtractionPrompt(sectionBoundaries?: BoundaryResult | null): string {
  return `You are extracting structured data directly from the attached image of a resume. Read the document as printed — do not invent information that is not actually present in the image in some recognizable form.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
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
    { "section_type": "summary" | "hobbies_other" | "additional_info" | "needs_review" | "skills_secondary", "heading": string, "content": string, "position": number }
  ]
}

ZERO-LOSS RULE (hard requirement — read this before classifying anything): every visible heading,
paragraph, table, or list on the page must be accounted for somewhere in your output. Never omit
visible content for any reason. Classify it into a real category (work_history, education,
certifications, skills) when it genuinely belongs there; otherwise it goes into "freeform" as
"summary", "hobbies_other", or "additional_info" only when it actually matches one of those three
definitions below, and as "needs_review" for everything else that doesn't fit anywhere —
needs_review is the universal fallback, always available, always correct when nothing else fits.
Never force content into a category it doesn't genuinely belong in just to give it a home.

CLASSIFICATION IS SECTION-DRIVEN, DECIDED BEFORE THIS STEP — READ THIS FIRST (Decision 38, 2026-09-18):
the category every item below belongs to is NOT something this step decides by judging an individual
item's own shape or content pattern. It was already decided, per-SECTION, in a separate step that ran
before this one — see "SECTION BOUNDARIES FOR THIS DOCUMENT" further down this prompt (when present)
for the actual, final category of every section. Once a section's category is fixed, every item under
it gets that category, full stop — do not independently re-judge a specific item against these category
definitions by its own shape or wording once it's inside an already-assigned section. These definitions
below describe what a category MEANS and how to extract its fields correctly once assigned (heading
capture, line breaks, license numbers, date rules, and so on) — not how to decide category in the first
place; that decision is upstream of this step now.

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

- LINE-BREAK PRESERVATION (real, confirmed failure mode — a real source document with bulleted
  content came back as one dense, run-on paragraph with every bullet's line break silently
  discarded): this applies to "job_responsibilities" (work_history) and "content" (freeform) alike.
  Whenever the source itself presents this field's content as distinct bullets, dashes, or separate
  lines — not as flowing prose — reproduce that structure verbatim using "\n" between each item.
  Judge this the same way as everywhere else in this prompt: by the source's own SHAPE, not by
  whether a bullet character is literally present — a "Selected Career Highlights" or "Workplace
  Strengths" section printed as one item per line is a real line-separated list even without a
  visible bullet glyph, and job_responsibilities under a role is virtually always this shape (each
  responsibility its own line/bullet in the source). The one genuine exception is content that is
  actually continuous prose in the source (a paragraph-style professional summary, a single
  unbulleted sentence) — that stays as normal wrapped prose, no "\n" inserted where the source never
  had one. Never collapse a real bulleted list into a single comma- or period-joined sentence, and
  never invent a line break the source doesn't actually have.

- MULTI-COLUMN TABLE READING ORDER (real, confirmed failure mode — a section laid out as a 2- or
  3-column grid of short bullet cells, e.g. "Selected Career Highlights" or similar, got its cells
  read left-to-right across the grid as one continuous stream instead of down each column
  separately. Two symptoms of the same root cause were both observed on the same real document:
  unrelated cells' sentences spliced together mid-sentence, and single words split across a column
  boundary with a stray fragment left dangling on each side, e.g. "_satisfaction" and "_delivery" as
  the broken halves of "customer satisfaction" and "on-time project delivery"). DO NOT attempt to
  preserve the grid's row-by-row layout in your reading order at all — flatten it instead: read one
  column completely, top to bottom, start to finish, before reading the next column at all (the
  leftmost visual column first, then the column to its right, and so on) — never read across a row
  from one column's cell into another column's cell, and never let a row boundary decide reading
  order. Each cell is a separate, complete bullet; extract the whole grid as ONE flat, linear,
  sequential list of complete bullets in that column-by-column order, never merging two cells' text
  into one bullet and never leaving a word or clause fragment from one cell joined onto another's.
  This applies to ANY section laid out as a multi-column table or grid of short bullet cells, not
  just a section named "Selected Career Highlights" — judge by the source's own visual SHAPE (a grid
  of short items in aligned columns), not by section heading. There is no requirement to preserve
  the original column layout in your output — the generated result only ever shows this content as
  a single linear list regardless, so when in doubt, prefer keeping each cell's own sentence fully
  intact and separate over guessing at a merged reading order.

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
  under, exactly as printed (e.g. "PROFESSIONAL EXPERIENCE", "Employment History") — the ONE section
  title that governs the entire block of company entries, copied verbatim, not reworded, not invented,
  not guessed. It is NEVER an individual company's own header line (e.g. "CDW, Remote November 2015 -
  September 2020"), even though that line is often bold, sits on its own line, and sits directly above
  the role/title and bullets — exactly the way a real section heading looks. That company-level line
  belongs in the separate "company", "location", "start_date", and "end_date" fields instead; it must
  never be copied into "heading". A real, confirmed failure mode: on a resume with one outer
  "PROFESSIONAL EXPERIENCE" heading governing five different companies, four of the five companies each
  got their OWN "COMPANY, Remote [date] [date]" line as "heading" instead of "PROFESSIONAL EXPERIENCE"
  (only the fifth got it right) — and while copying that wrong text, the hyphen between the two dates
  was also dropped, so the same underlying mistake corrupted two different things at once. Every entry
  under one true outer section heading gets that SAME literal string — when two or more consecutive
  entries share the same visible section heading, all of them get it, not just the first, and never a
  company's own line instead. Use an empty string "" only when the resume genuinely has no visible
  section heading above this entry at all (e.g. a minimally-formatted document with no section labels
  anywhere, per THE ONE EXCEPTION rule above).
  This is additive only, like freeform's own "heading" field below — it does not change how content
  gets classified, only what section title the output can reproduce.

- SAME COMPANY, MULTIPLE ROLES — RUN THIS GATING TEST FIRST, before weighing any promotion or
  transition language, whenever a company name appears more than once in the work-history section
  (still getting this wrong after two earlier, weaker-worded attempts at this exact fix, 2026-09-23 —
  this version leads with the test itself rather than stating it as one consideration among several):

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
    - "title" = every role's own title, in chronological order (earlier role FIRST, later/current role
      LAST), joined as "First Title to Second Title" (extend the same way for three or more roles) —
      e.g. "Recruiter to Senior Recruiter" — never just the most senior/most recent title alone, which
      would misrepresent the whole tenure as having started at that level, and never the reverse order
      either. Determine which title is earlier from the subordinate aside's own wording, not from which
      title sounds more senior: a note reading "Promoted FROM [Title]," "Started as [Title]," or similar
      names the EARLIER title explicitly — that named title goes FIRST, and the header line's OWN title
      (the one with the company/location/date-range) goes SECOND, since the header always describes the
      tenure's current/most recent state. A real, confirmed failure mode: "Manager of Business Analysis
      and Publishing Systems | Thomson Reuters | ... | 1996-1998" with a subordinate note "Promoted
      mid-year from Desktop Publishing Manager (1996-1997)" came back as "Manager of Business Analysis
      and Publishing Systems to Desktop Publishing Manager" — backwards; "from" explicitly names Desktop
      Publishing Manager as the earlier role, so the correct title is "Desktop Publishing Manager to
      Manager of Business Analysis and Publishing Systems".
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
  same-tenure cases); when genuinely unsure whether two same-company entries are one continuous tenure
  or two disconnected stints, extract them as separate entries rather than guessing at a merge.

- education = DEGREE-GRANTING PROGRAMS ONLY (e.g. B.A., B.S., M.S., MBA, Ph.D., Associate's).

- education's "location" field = the institution's city/state (or city/country outside the US) as
  printed on the resume, near the institution's name, e.g. "Gainesville, FL". Copy it verbatim in
  whatever form it appears — do not reformat, abbreviate, or expand it. Use an empty string "" when
  no location is given for that institution — never infer or guess one from the institution's real-
  world location; only what's actually printed counts.

- education's "heading" field = the same concept as work_history's "heading" above, for whatever
  section this program sits under (e.g. "EDUCATION", "Academic Background") — literal text, verbatim,
  the same shared string across every entry under one visible heading, empty string "" only when the
  resume genuinely has none.

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
  both. Shared the same way issuing_body is shared: every item under one visible heading gets that
  same literal heading string. A trailing annotation inside a heading (an hours figure, a date range,
  a parenthetical note) is part of that heading text, never a standalone fact needing its own home
  elsewhere in the output. Use an empty string "" only when the resume genuinely has no visible
  heading for that list at all.

- CERT/LICENSE VS. SKILL DISAMBIGUATION WITHIN A MIXED SECTION (a targeted rule, not a universal
  requirement — most certifications and skills are unambiguous by shape per their own definitions
  above and need none of this, and per the section-driven classification rule above, this NEVER fires
  inside a section the boundary step already assigned a real category to): this applies ONLY inside a
  section the boundary step marked "unknown" — either genuinely headerless, or a real header that
  didn't semantically match any known category — AND that section's own content shows a genuine MIX —
  some items with a clearly discernible trailing certification/license number or identifier (a distinct
  number, code, or alphanumeric string following the item's name, whether or not it carries a
  conventional marker like "#", "No.", or "Lic. No." in front of it) and other items in that same
  section with no such identifier at all. When that specific mix occurs inside such a section, use the presence or absence
  of a discernible trailing identifier as the signal to split the section: items with one are
  certifications (the identifier captured in "license_number"), items without one are skills. Do NOT
  apply this as a blanket requirement for every certification — most legitimately have no license
  number (see the license_number field above) and are still certifications, classified normally. A
  trailing identifier can be genuinely hard to tell apart from ordinary text (a website address, a
  plain string of letters and numbers) with no conventional marker present — when a specific item's
  status is still ambiguous after applying this rule (you can't confidently tell whether a trailing
  string is really an identifier, or whether that item belongs with the certifications or the skills
  in this same mixed section), do not guess: classify that one item as "needs_review" instead, with
  its "heading" set to the section's real literal heading text and its "content" holding that item's
  own text verbatim — rather than forcing an ambiguous item into either certifications or skills.

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
  never folded into skills. This holds even when the resume ALSO has a separate, genuinely
  skills-shaped section elsewhere (e.g. "Core Competencies") — a second bulleted list later in the
  document is NOT automatically more of the same skills block just because its individual phrases
  look similar; check each item for its own explanatory clause before adding anything to skills.

- MULTIPLE DISTINCT SKILLS-SHAPED SECTIONS (a real, confirmed structure, different from the case just
  above — this one is about two sections that are BOTH genuinely skills-shaped, not one that only looks
  like it is): a resume can have more than one section that is a genuine flat list of terms, each with
  its own distinct heading — e.g. "CORE COMPETENCIES" (a list of competency phrases) immediately
  followed by "RECENT TECHNICAL SKILLS" (a list of named tools/software), two real, differently-headed
  lists back to back. The top-level "skills" array is ONE flat, unattributed list for the whole resume,
  so only the FIRST such section's terms go into "skills" (carrying that section's own heading the usual
  way, via the section-boundary step). Every ADDITIONAL skills-shaped section — one with its own
  genuinely different heading text, appearing after the first — goes into "freeform" instead of being
  merged into "skills": section_type "skills_secondary", "heading" set to that section's own literal
  heading text, "content" holding its terms exactly as the source presents them (comma-separated, one
  per line, however the source actually lists them — copied verbatim, not reformatted into a different
  list style). Never merge a second skills-shaped section's terms into the "skills" array just because
  both sections are skills-shaped — doing so silently discards the second section's own heading and
  visually merges two genuinely distinct sections into one. This does not apply to a single skills
  section that merely wraps across multiple lines or columns (still one section, one heading) — only to
  two or more sections with genuinely distinct heading text, per the general "never merge sections just
  because they're topically similar" rule.

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
  example. The same applies to every other category: a section header alone (e.g. "AI &
  Emerging Technology") is not itself an item — if the header has real, specific items listed under
  it, extract those (each is its own real entry); if it doesn't (no items follow it, or it's only
  ever described in summary form), the header and its content go to needs_review together,
  untouched, and no entry is invented to fill the gap. When in doubt whether something is a genuine
  standalone named item or just a description of one, treat it as needs_review — inventing an entry
  is never the safe choice, omitting nothing is.

- THE SAME RULE APPLIES ACROSS A SECTION'S OWN CATEGORY BOUNDARY, NOT JUST INSIDE NEEDS_REVIEW (a real,
  confirmed failure mode, 2026-09-23): a narrative sentence describing informal, self-directed, or
  continuing-education-style activity can sit inside a section whose OWN boundary-assigned category is
  "education" or "certifications" (a real "EDUCATION" or "CERTIFICATIONS" heading governs it) rather
  than needs_review — that placement never makes it a genuine certifications entry. Real example: an
  EDUCATION section's own line reading "Continuing Education: 55+ hours of AI & emerging technology
  certification coursework — Coursiv, 2024–2025" is a narrative caption sentence, not a discrete named
  credential — even though it names an hours figure, a provider ("Coursiv"), and dates, the same shape
  the NEVER-FABRICATE rule above already warns about. It must stay as part of the education section's
  own content (or needs_review if it has no education content of its own to attach to) — never split
  out into its own certifications entry, regardless of which section physically contains it.

- "summary" (freeform) = any professional summary / objective / about-me blurb at the top of the
  resume. "hobbies_other" (freeform) = interests, hobbies, and volunteer/community activities ONLY
  — this is NOT a general catch-all. Content that isn't actually a hobby, interest, or volunteer
  activity, and doesn't genuinely fit work_history, education, certifications, or skills, belongs in
  "additional_info" or "needs_review" instead (see below), never here. Summary and hobbies/other
  content must NEVER be placed into work_history, education, certifications, or skills, even if it
  superficially resembles one of them.

- "additional_info" (freeform, 2026-09-23) = a real, distinctly-headed section matching one of the
  common, recognizable-but-not-independently-verified patterns: "Projects" / "Portfolio" (a list of
  named personal or professional projects, each with its own sub-heading, tool stack, or date range),
  "Career Highlights" / "Selected Career Highlights" / "Achievements," "Workplace Strengths," "Professional
  Affiliations," "Awards," "Publications," "Languages," or similar. This is delivered on the candidate's
  resume by default, the same as hobbies_other — it is NOT a paywalled or flagged-for-review category,
  because it is a recognized, common section type. Capture the section's FULL content verbatim in
  "content" (see the MULTIPLE NAMED SUB-ENTRIES boundary rule above for sections containing several
  named sub-entries) — do not shorten, summarize, or drop any of it. A section only gets
  "additional_info" when its own real header clearly matches one of these recognizable patterns; a
  header that is vague, ambiguous, or doesn't fit even loosely still goes to "needs_review" instead —
  this category is for clearly-recognizable common section types only, never a second general catch-all.

- "needs_review" (freeform) = the universal catch-all for anything real and visible on the page that
  doesn't genuinely belong in work_history, education, certifications, skills, summary, hobbies_other,
  or additional_info. This includes — but is not limited to — a role that reads as unpaid employment
  (see the work_history rule above), a clearly-titled section whose header names something too vague
  or unrecognizable to match ANY category above (including additional_info's own list of common
  patterns), and any content you can't confidently attribute to another category. When genuinely
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
  Each entry's position must be genuinely unique on the page (real, confirmed failure mode: four
  separate certification bullets under one heading all came back with the identical position value
  — harmless by coincidence that time since nothing else fell between them once sorted, but not a
  safe pattern to rely on) — every entry has its own distinct reading-order spot, never shared with
  a sibling entry even when several appear close together or under the same heading. If several
  items truly sit on the exact same visual line (rare), give them consecutive integers in the order
  a reader's eye would actually take them (e.g. left-to-right for a same-row pair), not the same
  number.
  If the resume shows language proficiency as icons, bars, dots, or other non-text graphics rather
  than words, describe what you can determine from the graphic (e.g. the language name and an
  approximate level like "native/fluent/conversational/basic" if the graphic clearly conveys a
  level) in a "summary" or "hobbies_other" freeform entry — do not silently drop it, and do not
  invent a precision level the graphic doesn't actually convey.

DATES: write every date exactly as precisely as the resume prints it, never more precisely. Use YYYY
when the resume gives only a year, YYYY-MM when it gives a month and year, and YYYY-MM-DD only when it
gives a specific day (rare). NEVER fill in a month or day the resume does not show: a bare "2019" is
"2019", not "2019-01" and not "2019-01-01". If a role/program is current/ongoing ("Present", "Current",
"Now"), write the word Present as its end_date. If a date is entirely absent or unrecoverable, use an
empty string "" for that field, not a guess.

If a category has no entries, return an empty array for it — do not omit the key.${buildSectionBoundaryBlock(sectionBoundaries)}`;
}

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

// STRUCTURAL QA CHECK (2026-09-14 live-testing session): a deterministic, cheap net for the two
// specific extraction-corruption SHAPES confirmed live today via a real 4-run spot check against
// the exact same source document, on the exact same currently-deployed prompts — see
// verifi-extraction-nondeterminism-open-item memory for the full finding. This does NOT solve
// non-determinism (that stays a standing, tracked, unsolved problem) and does NOT try to judge
// whether content is semantically correct — it only catches the specific structural fingerprints
// two real, observed bad runs left behind, cheaply enough to run on every page of every upload.
//
// 1. Mid-line terminal punctuation (interleaving signal): a genuine, complete bullet's sentence-
//    ending punctuation is the LAST non-whitespace character of its own line. The real corrupted
//    run found today ("...strategic workflow redesign. goal") had a period buried mid-line with
//    more (unrelated, spliced-in) text trailing after it — two bullets woven together leave
//    exactly this shape. A clean bullet never has this.
// 2. Anomalously short certification entries (wrapped-item-split signal): a real credential name
//    is virtually always a multi-word phrase. The real split found today turned one entry
//    ("Multimodal AI & Productivity Integration (Gemini)") into two short fragments
//    ("Multimodal Productivity (Gemini)" + "AI & Integration") — one of the two lands far shorter
//    than its siblings on the same page. Certifications only, deliberately not skills: a skill
//    entry is often legitimately this short ("SQL", "Python") and would make this pure noise.
//
// Neither check can prove content is RIGHT, only flag a shape matching a confirmed-real WRONG —
// false negatives (a bad run this doesn't happen to match) are expected and are exactly why this
// is a mitigation, not a fix. Thresholds (20 chars, 0.5x median) are first-pass judgment calls
// from the two real examples in hand, not tuned against a larger sample — a genuine follow-up
// study, not something to over-fit further today.
function findStructuralIssues(extraction: ExtractionResult): string[] {
  const issues: string[] = [];

  const checkLinesForMidLinePunctuation = (text: string | undefined | null, label: string) => {
    if (!text) return;
    const lines = text.split("\n");
    // Real false positive caught live (2026-09-14): a "PROFESSIONAL SUMMARY"-style freeform entry
    // is genuine continuous prose stored as ONE line (see the LINE-BREAK PRESERVATION rule this
    // pipeline's own prompts already follow) — a single line legitimately containing several full
    // sentences, each with its own mid-line period, is completely normal there and isn't the
    // splice/interleaving shape this check exists for. That shape only makes sense for content that
    // is ALREADY structured one-bullet-per-line (2+ lines) — restricting to that shape is what
    // actually distinguishes "normal multi-sentence prose" from "one bullet with another bullet's
    // text spliced into it."
    if (lines.length < 2) return;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 20) continue; // too short for a mid-line-punctuation signal to mean anything
      const bodyWithoutFinalChar = trimmed.slice(0, -1);
      if (/[.!?]/.test(bodyWithoutFinalChar)) {
        issues.push(`${label}: terminal punctuation mid-line, not at the end — possible spliced/interleaved content: "${trimmed.slice(0, 80)}"`);
      }
    }
  };
  (extraction.freeform || []).forEach((f, i) => checkLinesForMidLinePunctuation(f.content, `freeform[${i}]`));
  (extraction.work_history || []).forEach((w, i) => checkLinesForMidLinePunctuation(w.job_responsibilities, `work_history[${i}].job_responsibilities`));

  const certs = extraction.certifications || [];
  if (certs.length >= 3) {
    const lengths = certs.map((c) => (c.name || "").length).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)];
    certs.forEach((c, i) => {
      const len = (c.name || "").length;
      if (len > 0 && len < 20 && len < median * 0.5) {
        issues.push(`certifications[${i}]: "${c.name}" unusually short next to its siblings (median ${median} chars) — possible wrapped-item split`);
      }
    });
  }

  return issues;
}

// Sends the sanitized JPEG bytes already in hand straight to vision — no Storage round-trip
// needed, unlike test-vision-extract which had to fetch by path. Throws on any failure; caller is
// responsible for marking the document 'failed'. max_tokens=16000 and no `temperature` param are
// both load-bearing: Sonnet 5 rejects `temperature` outright (400), and 16000 was the number that
// stopped real truncation (`stop_reason: "max_tokens"`) seen at 8192 during tonight's testing —
// thinking-token overhead varies run to run and eats into the same budget as the answer.
// STEP 1 OF 2 execution (Decision 38): cheap, small-output call — no item extraction happens here,
// so max_tokens stays far below the full-extraction call below. Same VISION_MODEL as step 2 for
// consistency; no temperature set, same constraint as step 2 (Sonnet 5 rejects it outright under
// adaptive thinking).
async function runBoundaryDetectionVision(sanitizedBase64: string): Promise<BoundaryResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sanitizedBase64 } },
          { type: "text", text: buildBoundaryDetectionPrompt() },
        ],
      }],
    }),
  });
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }
  const claudeData = await claudeRes.json();
  const textBlock = (claudeData?.content ?? []).find((b: { type?: string }) => b.type === "text");
  const rawText: string = textBlock?.text ?? "";
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`malformed_boundary_response: ${String(e)}`);
  }
  if (!isValidBoundaryResult(parsed)) throw new Error("boundary_response_wrong_shape");
  return parsed;
}

async function runVisionExtraction(sanitizedBase64: string, sectionBoundaries?: BoundaryResult | null): Promise<ExtractionResult> {
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
          { type: "text", text: buildVisionExtractionPrompt(sectionBoundaries) },
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
  data: { ok?: boolean; page_count?: number; extraction?: unknown; ocr_raw_text?: string; routing?: { method?: string }; render?: unknown; timing_ms?: unknown; model_calls?: unknown; ocr_strips?: unknown; code?: string; error?: string; message?: string };
  status: number;
};

type AttemptLog = { dpi: number; force_vision: boolean; ms: number; status: number; code?: string; relay_calls: number };
type RasterizeOutcome = RasterizePageResult & { attempts: AttemptLog[] };

async function callRasterizePage(storagePath: string, pageNumber: number, opts?: { targetDpi?: number; forceVision?: boolean; previousPageContext?: TrailingItemContext }, signal?: AbortSignal): Promise<RasterizePageResult> {
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
    signal,
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
//
// TWO ADDITIONS (2026-09-19, resume-parsing slowness investigation):
//  * deadline: every attempt is bounded by the invocation's own time budget (AbortSignal), and no attempt is
//    started with under 5 s left. An attempt that cannot finish inside this invocation is abandoned so the
//    caller can checkpoint and continue in a fresh one, rather than running into the platform's ~150 s kill.
//  * startWithVision: measured on a real resume, tesseract kills the isolate on EVERY page (5/5 tries, at both
//    150 and 110 DPI), so each page burned ~8 s on two dead attempts before reaching the vision route that
//    actually works. When the previous page in this document needed that last-resort vision route, the next one
//    goes straight to it (at RASTERIZE_RETRY_DPI). If the earlier failure was transient contention rather than a
//    property of this document, that costs the faster tesseract route on the later pages — slower, never wrong.
async function rasterizePageWithRetry(storagePath: string, pageNumber: number, previousPageContext: TrailingItemContext | undefined, opts: { deadline: number; startWithVision?: boolean }): Promise<RasterizeOutcome> {
  const attempts: AttemptLog[] = [];
  const run = async (o: { targetDpi?: number; forceVision?: boolean }): Promise<RasterizePageResult> => {
    const t = Date.now();
    const remaining = opts.deadline - t;
    if (remaining < 5_000) throw new Error("invocation_budget_exhausted");
    const r = await callRasterizePage(storagePath, pageNumber, { ...o, previousPageContext }, AbortSignal.timeout(remaining));
    // Relay calls this attempt cost the trace: the call itself, plus one per OCR strip rasterize-pdf-page fanned out to
    // (and any retry/split of a strip). See the RELAY BUDGET note in the resumable-extraction header.
    const strips = (r.data as { ocr_strips?: { count?: number; strips?: Array<{ attempts?: number }> } })?.ocr_strips;
    const stripCalls = (strips?.count ?? 0) + (strips?.strips ?? []).reduce((n, s) => n + Math.max(0, (s.attempts ?? 1) - 1), 0);
    attempts.push({ dpi: o.targetDpi ?? 150, force_vision: !!o.forceVision, ms: Date.now() - t, status: r.status, code: (r.data?.code || r.data?.error) as string | undefined, relay_calls: 1 + stripCalls });
    return r;
  };
  if (opts.startWithVision) {
    return { ...(await run({ targetDpi: RASTERIZE_RETRY_DPI, forceVision: true })), attempts };
  }
  const attempt1 = await run({});
  if (attempt1.data?.code !== RESOURCE_LIMIT_CODE) return { ...attempt1, attempts };
  console.log(`upload-resume: page ${pageNumber} hit ${RESOURCE_LIMIT_CODE} at default DPI, retrying at ${RASTERIZE_RETRY_DPI} DPI`);

  const attempt2 = await run({ targetDpi: RASTERIZE_RETRY_DPI });
  if (attempt2.data?.code !== RESOURCE_LIMIT_CODE) return { ...attempt2, attempts };
  console.log(`upload-resume: page ${pageNumber} hit ${RESOURCE_LIMIT_CODE} again at ${RASTERIZE_RETRY_DPI} DPI, retrying with force_vision`);

  return { ...(await run({ targetDpi: RASTERIZE_RETRY_DPI, forceVision: true })), attempts };
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
// Structured continuation state handed to the NEXT page's rasterize-pdf-page call as
// previous_page_context — kept in sync by hand with the identical type in rasterize-pdf-page/index.ts
// (same convention as ExtractionResult/FIELD_DEFINITIONS already used across these functions).
// Replaced a plain one-line English description on 2026-09-14 after a structured N=9 same-document
// repro study (see verifi-extraction-nondeterminism-open-item memory) found page-boundary-spanning
// content fails 11-44% of the time — mostly vanishing outright, not just landing unlabeled — while
// single-page content was 100% reliable across all 9 runs. Explicit fields let the next page's own
// prompt give a directive, kind-specific instruction instead of asking the model to parse a sentence.
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

// describeTrailingItem is half the fix: after each page's OWN extraction, this summarizes whatever
// was position-last on THAT page (the most plausible thing a following page might continue), so it
// can be threaded into the NEXT page's rasterize-pdf-page call as previous_page_context — see that
// function's own buildContinuationContext for how it's used. Deliberately excludes education: a
// degree entry is one complete fact, not an open-ended list a following page would plausibly
// continue, so including it would just be noise the model has to read past.
// Fix for the OPEN bug this comment used to only describe (2026-09-23, see
// [[verifi-describeTrailingItem-wrong-selection-open-item]] for the full root-cause writeup and the
// confirmed-live regression that forced this now rather than later): "highest position on this page"
// is not the same thing as "genuinely still open, continuing onto the next page." A work_history entry
// with its own explicit closing date, or a certifications/license entry (a complete, self-sufficient
// fact once extracted — never itself still being described further down), can still happen to be the
// LAST thing positionally on a page while being fully closed. Wrongly treating either as "trailing"
// injects a false CONTINUATION AWARENESS note into the next page's boundary-detection prompt — and
// live reproduction (2026-09-23, real upload-resume + rasterize-pdf-page pipeline, not the
// extract-resume-fields-direct shortcut) showed this doesn't just risk dropping genuine continuation
// content (the original finding): it also measurably degrades that SAME call's unrelated
// SAME-COMPANY-MULTIPLE-ROLES judgment for content entirely within the next page, with no actual
// cross-page continuation involved at all. Isolating the next page's own content with no
// previous_page_context produced the correct merge; feeding it the wrong trailing hint broke it.
function isOpenEndedDate(endDate?: string): boolean {
  const v = (endDate || "").trim().toLowerCase();
  return v === "" || v === "present" || v === "current" || v === "now";
}
function describeTrailingItem(extraction: ExtractionResult): TrailingItemContext | undefined {
  type Candidate = { position: number; open: boolean; build: () => TrailingItemContext };
  const candidates: Candidate[] = [];
  for (const w of extraction.work_history) {
    if (typeof w.position !== "number") continue;
    candidates.push({
      position: w.position,
      // Open only when the role has no fixed closing date (blank, or "Present"/"Current"/"Now") — a
      // role stating its own end date is a complete, closed fact and isn't plausibly still being
      // described on the next page.
      open: isOpenEndedDate(w.end_date),
      build: () => ({ kind: "work_history", company: w.company || "", title: w.title || "", heading: w.heading || "", snippet: (w.job_responsibilities || "").slice(-220) }),
    });
  }
  for (const c of extraction.certifications) {
    if (typeof c.position !== "number") continue;
    candidates.push({
      position: c.position,
      // Never open: a cert/license entry (name, issuer, date) is complete the moment it's extracted.
      // The multi-item-list-continuation case (a certifications LIST whose remaining items spill onto
      // the next page) is handled separately and doesn't depend on this flag.
      open: false,
      build: () => ({ kind: "certifications_list", name: c.name || "", issuingBody: c.issuing_body || "", heading: c.heading || "", snippet: c.name || "" }),
    });
  }
  for (const f of extraction.freeform) {
    if (typeof f.position !== "number") continue;
    candidates.push({
      position: f.position,
      // Freeform sections (summary, hobbies/other, needs_review) have no analogous closing-date
      // signal — keep treating the position-last one as plausibly open, unchanged from before this fix.
      open: true,
      build: () => ({ kind: "freeform", heading: f.heading || "", sectionType: f.section_type || "needs_review", snippet: (f.content || "").slice(-220) }),
    });
  }
  const openCandidates = candidates.filter((c) => c.open);
  if (openCandidates.length === 0) return undefined;
  openCandidates.sort((a, b) => b.position - a.position);
  return openCandidates[0].build();
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
  // Real bug fixed here (found investigating the missing "Workplace Strengths" section, same
  // session as the position-collision and line-break fixes): this used to require BOTH headings to
  // be non-empty and equal, which can never match an unlabeled continuation — exactly the case the
  // freeform-heading rule's own prompt text documents ("Use an empty string '' only when the content
  // genuinely has no visible heading of its own, e.g. an unlabeled continuation of a previous
  // section"). A page-N+1 item with heading "" following a page-N item with a real heading is that
  // exact documented case, and needs to merge into it — not fall through and stay a separate,
  // headless second row.
  //
  // A first version of this fix (deployed, then re-tested against the same source document) merged
  // ANY page-adjacent empty-heading item into whatever freeform entry happened to be last, with no
  // further check — confirmed live to be unsafe: a SECOND, unrelated empty-heading fragment later on
  // the SAME page (the source document's trailing "Continuing Education..." line, which should have
  // been its own "EDUCATION" entry but came back unlabeled) got silently glued onto the already-
  // merged section instead of staying separate, because prevPage was derived from prev's ORIGINAL
  // page and never updated after a merge — a second same-page item still read as "adjacent." Fixed
  // by tracking each merged entry's own true last-absorbed page (mutable, updated on every merge,
  // not re-derived from a stale position) AND only allowing the unlabeled-continuation match for the
  // FIRST freeform item extracted from a given page — a genuine "this page opened mid-section" case
  // is always the first thing on that page; a later unlabeled item on the same page is much more
  // likely a separate, independently-ambiguous fragment that just happens to also lack a heading,
  // not a continuation of the same thing. Still conservative otherwise: page-adjacency is still
  // required either way, and this never merges two DIFFERENT non-empty headings, only an empty one
  // into the section it says it's continuing.
  const seenPages = new Set<number>();
  const lastPageOf = new Map<(typeof freeform)[number], number>();
  for (const item of freeform) {
    const prev = mergedFreeform[mergedFreeform.length - 1];
    const prevPage = prev ? (lastPageOf.get(prev) ?? pageOf(prev.position)) : null;
    const itemPage = pageOf(item.position);
    const isFirstOnItsPage = itemPage !== null && !seenPages.has(itemPage);
    if (itemPage !== null) seenPages.add(itemPage);

    const isMatchingHeadings = !!(prev?.heading && item.heading && norm(prev.heading) === norm(item.heading));
    const isUnlabeledContinuation = !!(prev?.heading && !item.heading && isFirstOnItsPage);
    if (
      prev && prevPage !== null && itemPage !== null && itemPage === prevPage + 1 &&
      (isMatchingHeadings || isUnlabeledContinuation)
    ) {
      prev.content = `${prev.content}\n\n${item.content}`.trim();
      if (itemPage !== null) lastPageOf.set(prev, itemPage);
      continue;
    }
    mergedFreeform.push({ ...item });
  }

  const workHistory = [...extraction.work_history].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const mergedWorkHistory: typeof workHistory = [];
  // Audit finding, 2026-09-14 (non-determinism study follow-up): prevPage used to be re-derived from
  // prev.position on every iteration, which never changes once an entry is pushed — so a job
  // spanning 3+ consecutive pages (page N opens it, page N+1 continues it, page N+2 continues it
  // again) would correctly merge the N+1 continuation, but then fail the N+2 merge: prevPage still
  // reads as page N, so itemPage (N+2) !== prevPage+1 (N+1). Same bug class the freeform loop above
  // was already fixed for (see its own comment); mirrored here with the same lastPageOf tracking.
  const lastWorkHistoryPageOf = new Map<(typeof workHistory)[number], number>();
  for (const item of workHistory) {
    const prev = mergedWorkHistory[mergedWorkHistory.length - 1];
    const prevPage = prev ? (lastWorkHistoryPageOf.get(prev) ?? pageOf(prev.position)) : null;
    const itemPage = pageOf(item.position);
    const isPageAdjacent = !!(prev && prevPage !== null && itemPage !== null && itemPage === prevPage + 1);
    const isMatchingHeader = isPageAdjacent &&
      !!prev!.company && !!item.company && norm(prev!.company) === norm(item.company) &&
      !!prev!.title && !!item.title && norm(prev!.title) === norm(item.title);
    // Audit finding, 2026-09-14 (non-determinism study, fix iteration 2): the prompt-side fix asks
    // the model to copy the previous job's company/title verbatim onto a continuation row so the
    // exact-match check above fires — confirmed live this doesn't always happen: a real run
    // extracted the continuation bullets correctly as their own work_history entry but left
    // company AND title blank, so the match above silently failed and it sat as an unmerged orphan
    // row instead of merging. A genuinely NEW, separate job can never have both company and title
    // blank (see FIELD_DEFINITIONS — both are expected whenever a real role is being described), so
    // a page-adjacent row with both fields empty is unambiguously a continuation of whatever came
    // immediately before it, not a coincidence — this doesn't depend on the model reliably copying
    // anything, it's a deterministic property of the row itself.
    const isBlankContinuation = isPageAdjacent && !item.company && !item.title;
    if (prev && (isMatchingHeader || isBlankContinuation)) {
      prev.job_responsibilities = `${prev.job_responsibilities}\n\n${item.job_responsibilities}`.trim();
      if (itemPage !== null) lastWorkHistoryPageOf.set(prev, itemPage);
      continue;
    }
    mergedWorkHistory.push({ ...item });
  }

  return { ...extraction, freeform: mergedFreeform, work_history: mergedWorkHistory };
}

// Item B (2026-09-13 PDF-regression follow-up session): server-side, deterministic replacement for
// the earlier prompt-only "ensure positions are genuinely unique" instruction. Confirmed via a real
// re-test against the same source document that the prompt wording had ZERO effect: the exact same
// 4 certifications still came back sharing one position value, identical to before that instruction
// was added — LLM self-compliance on a positional-uniqueness constraint isn't reliable and this
// stops relying on it. Instead, every position-bearing item across every category, PLUS the single
// skills-block position, is collected, sorted by its extracted position (ties broken by original
// emission order — itself the LLM's own reading-order within whatever page/category produced it,
// so a tied group's relative order is preserved rather than randomized), and renumbered to strictly
// increasing integers in that same relative order. This can never leave two items sharing a
// position, and never changes the relative ordering the extraction actually produced — it only
// removes ties. Deliberately runs AFTER mergeExtractions/mergeBoundaryContinuations, not before:
// those still need the original page-encoded position values (see pageOf() above) to find
// cross-page adjacency; once that's done, nothing downstream needs the page-encoded magnitude, only
// the relative order, which this preserves exactly.
function dedupePositions(extraction: ExtractionResult): ExtractionResult {
  type PosRef = { get: () => number | undefined; set: (n: number) => void };
  const refs: PosRef[] = [];
  for (const w of extraction.work_history) refs.push({ get: () => w.position, set: (n) => { w.position = n; } });
  for (const e of extraction.education) refs.push({ get: () => e.position, set: (n) => { e.position = n; } });
  for (const c of extraction.certifications) refs.push({ get: () => c.position, set: (n) => { c.position = n; } });
  for (const f of extraction.freeform) refs.push({ get: () => f.position, set: (n) => { f.position = n; } });
  if (typeof extraction.skills_position === "number") {
    refs.push({ get: () => extraction.skills_position ?? undefined, set: (n) => { extraction.skills_position = n; } });
  }
  const indexed = refs.map((r, i) => ({ r, i, pos: r.get() }));
  // Items with no numeric position at all (shouldn't normally happen, but not asserted-on) sort
  // after every real position, keeping their own relative order rather than colliding at 0.
  indexed.sort((a, b) => {
    const aHas = typeof a.pos === "number", bHas = typeof b.pos === "number";
    if (aHas && bHas) return (a.pos! - b.pos!) || (a.i - b.i);
    if (aHas) return -1;
    if (bHas) return 1;
    return a.i - b.i;
  });
  indexed.forEach(({ r }, seq) => r.set(seq));
  return extraction;
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
    // the first page that reported the skills block's heading (a skills list that runs onto a later page has no heading there)
    skills_heading: (() => {
      const withHeading = pages.find(({ extraction }) => !!cleanHeading(extraction.skills_heading));
      return withHeading ? cleanHeading(withHeading.extraction.skills_heading) : "";
    })(),
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

// ---------------------------------------------------------------------------------------------------
// RESUMABLE PDF EXTRACTION (2026-09-19)
//
// The platform kills an Edge Function invocation at ~150 s of wall clock. Every page of a PDF used to be read
// inside ONE invocation, so a resume that could not be finished in that window lost everything, including the
// pages already read. Measured on a real 2-page resume whose pages take the Sonnet-vision route (tesseract cannot
// run on it): ~139 s end to end — a third page, or any slow model call, and the candidate gets nothing.
// Where a page's time goes (per-call instrumentation in rasterize-pdf-page): the vision extraction call is 30-50 s
// per page, ~65-70% of it adaptive-thinking tokens, versus ~3-5 s for the tesseract+Haiku route.
//
// Shape of the fix: each page is checkpointed (resume_extraction_pages) as soon as it is read. An invocation stops
// before it would run out of time and answers { continue: true }; the client calls this function again with just
// { resume_document_id } (and the resume screen's own poll does the same if the tab was closed in between). Every
// invocation gets a fresh ~150 s, so page count is no longer bounded by the platform limit.
//
//   * Lease: an invocation holds extraction_lease_until while it works; a continuation claims the document only if
//     that is empty or expired (atomic conditional UPDATE), so two overlapping calls never process it together.
//   * Stalls: each claim bumps extraction_stalls; every checkpointed page resets it. Three claims in a row that
//     produce no page mark the document 'failed' — a genuinely unreadable page ends, it does not loop forever.
//   * Previous-page context (the boundary/continuation fix) is rebuilt from the STORED previous page, never from
//     memory, so a resumed run feeds page N exactly what an uninterrupted run would have.
//   * (The structural-QA re-read that used to sit here is gone, see the note where findStructuralIssues is called.)
//   * Parallelising the two model calls (boundary, then extraction) or the pages was rejected on purpose: step 2
//     consumes step 1's output, and each page's prompt carries the previous page's trailing item — running them
//     together brings back the boundary/continuation contradiction fixed on 2026-09-18.
// ---------------------------------------------------------------------------------------------------
// RELAY BUDGET (2026-09-19, found live while building strip OCR): the platform allows only 30 nested function calls
// per minute within one TRACE (one client request and everything it calls in turn); the 31st throws
// "RateLimitError: Rate limit exceeded for trace ..." from fetch itself (measured: bursts of 32/64/100 parallel calls
// from one invocation all succeeded exactly 30 times). A page read through strip OCR costs 1 (this function's call to
// rasterize-pdf-page) + one per strip (~8 on a dense page) = ~9, so a 4th dense page inside one invocation would trip
// it, and once tripped every further call in that trace fails for the rest of the minute. An invocation therefore
// counts the relay calls it has spent and stops (continue: true) before the next page could exceed
// RELAY_CALLS_PER_INVOCATION; the client's next call is a NEW trace with a fresh budget, so this costs one round
// trip, not time. A RateLimitError that still slips through surfaces as a thrown fetch error, which this loop already
// treats as "end this invocation, continue in a fresh one".
const RELAY_CALLS_PER_INVOCATION = 22;    // platform limit is 30/min/trace; the margin covers strip retries/splits and a QA re-read
const DEFAULT_PAGE_RELAY_CALLS = 10;      // assumed cost of a page before one has been measured this invocation
const INVOCATION_LIMIT_MS = 140_000;      // platform kills at ~150 s
const FINALIZE_RESERVE_MS = 12_000;       // merge + insert RPC + status writes after the last page
const DEFAULT_PAGE_COST_MS = 65_000;      // assumed cost of a page before one has been timed this invocation (measured vision page: 41-59 s plus dead attempts)
const PAGE_COST_MARGIN = 1.25;
const EXTRACTION_LEASE_MS = 150_000;
const MAX_EXTRACTION_STALLS = 3;

type PageTiming = {
  page_ms: number;
  attempts: AttemptLog[];
  routing: string | null;
  needed_force_vision: boolean;
  render?: unknown;
  timing_ms?: unknown;
  model_calls?: unknown;
  qa: { fired: boolean; deferred: boolean; skipped?: "vision_route" | "no_measured_benefit"; issues_before?: number; issues_after?: number; retry_ms?: number; kept?: "retry" | "original" };
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function claimExtractionLease(supabase: any, docId: string, currentStalls: number): Promise<boolean> {
  const { data, error } = await supabase.from("resume_documents")
    .update({ extraction_lease_until: new Date(Date.now() + EXTRACTION_LEASE_MS).toISOString(), extraction_stalls: currentStalls + 1 })
    .eq("id", docId).eq("extraction_status", "pending").eq("extraction_stalls", currentStalls)
    .or(`extraction_lease_until.is.null,extraction_lease_until.lt.${new Date().toISOString()}`)
    .select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

// Entry for a continuation call: body is { resume_document_id } with no file bytes.
async function continuePdfExtraction(supabase: any, docId: string, invocationStart: number): Promise<Response> {
  const { data: doc } = await supabase.from("resume_documents")
    .select("id, original_storage_path, mime_type, extraction_status, extraction_stalls").eq("id", docId).maybeSingle();
  if (!doc) return jsonResponse({ ok: false, error: "resume_document_not_found" }, 404);
  if (doc.mime_type !== "application/pdf") return jsonResponse({ ok: false, error: "not_resumable", message: "Only PDF extraction is resumable." }, 400);
  if (doc.extraction_status === "extracted") return jsonResponse({ ok: true, resume_document_id: docId, extraction_status: "extracted", continue: false });
  if (doc.extraction_status !== "pending") return jsonResponse({ ok: false, error: "not_pending", extraction_status: doc.extraction_status, resume_document_id: docId }, 409);
  if ((doc.extraction_stalls ?? 0) >= MAX_EXTRACTION_STALLS) {
    await supabase.from("resume_documents").update({ extraction_status: "failed", extraction_lease_until: null }).eq("id", docId);
    return jsonResponse({ ok: false, error: "extraction_stalled", message: "Extraction made no progress across repeated attempts.", resume_document_id: docId }, 502);
  }
  const claimed = await claimExtractionLease(supabase, docId, doc.extraction_stalls ?? 0);
  // Not claimed = another invocation holds the lease (or advanced the state first). Nothing to do but wait.
  if (!claimed) return jsonResponse({ ok: true, resume_document_id: docId, extraction_status: "pending", continue: false, running: true });
  return await processPdfPages(supabase, docId, doc.original_storage_path, invocationStart);
}

async function processPdfPages(supabase: any, docId: string, originalPath: string, invocationStart: number): Promise<Response> {
  const pageDeadline = invocationStart + INVOCATION_LIMIT_MS - FINALIZE_RESERVE_MS;
  const releaseLease = async () => { await supabase.from("resume_documents").update({ extraction_lease_until: null }).eq("id", docId); };
  const fail = async (status: number, payload: Record<string, unknown>) => {
    await supabase.from("resume_documents").update({ extraction_status: "failed", extraction_lease_until: null }).eq("id", docId);
    return jsonResponse({ ok: false, resume_document_id: docId, ...payload }, status);
  };

  const { data: docMeta } = await supabase.from("resume_documents").select("extraction_page_count, candidate_id").eq("id", docId).maybeSingle();
  let pageCount: number | null = docMeta?.extraction_page_count ?? null;
  const { data: rowsData } = await supabase.from("resume_extraction_pages")
    .select("page_number, extraction, ocr_text, qa_retry, timing").eq("resume_document_id", docId).order("page_number", { ascending: true });
  const rows = new Map<number, { page_number: number; extraction: ExtractionResult; ocr_text: string | null; qa_retry: string; timing: PageTiming | null }>();
  for (const r of rowsData ?? []) rows.set(r.page_number, r);

  const pageCosts: number[] = [];
  let relayCalls = 0;                      // nested function calls this invocation has spent (see RELAY BUDGET above)
  const pageRelay: number[] = [];
  const canStartAnotherPage = () =>
    Date.now() + (pageCosts.length ? Math.max(...pageCosts) : DEFAULT_PAGE_COST_MS) * PAGE_COST_MARGIN <= pageDeadline &&
    relayCalls + (pageRelay.length ? Math.max(...pageRelay) : DEFAULT_PAGE_RELAY_CALLS) <= RELAY_CALLS_PER_INVOCATION;
  const contextFor = (pn: number) => (rows.get(pn - 1) ? describeTrailingItem(rows.get(pn - 1)!.extraction) : undefined);
  const hintFor = (pn: number) => rows.get(pn - 1)?.timing?.needed_force_vision === true;
  const continueResponse = async () => {
    await releaseLease();
    return jsonResponse({ ok: true, resume_document_id: docId, extraction_status: "pending", extraction_method: "pdf_rasterize", page_count: pageCount, pages_done: rows.size, continue: true });
  };
  let unitsDone = 0;

  try {
    // 1. Pages, in order.
    for (let pn = 1; pn <= Math.min(pageCount ?? 1, MAX_PDF_PAGES); pn++) {
      if (rows.has(pn)) continue;
      if (unitsDone > 0 && !canStartAnotherPage()) return await continueResponse();
      unitsDone++;
      const outcome = await rasterizePageWithRetry(originalPath, pn, contextFor(pn), { deadline: pageDeadline, startWithVision: hintFor(pn) });
      const pageMs = outcome.attempts.reduce((n, a) => n + a.ms, 0);
      const pageCalls = outcome.attempts.reduce((n, a) => n + a.relay_calls, 0);
      relayCalls += pageCalls;
      pageRelay.push(pageCalls);
      const d = outcome.data;
      if (!outcome.ok || !d.ok || !isValidExtraction(d.extraction)) {
        const stillResourceLimited = d.code === RESOURCE_LIMIT_CODE;
        return await fail(502, {
          error: stillResourceLimited ? "pdf_page_extraction_failed_after_retries" : "pdf_page_extraction_failed",
          detail: d.message || d.error || d.code || "unknown_error", page: pn,
        });
      }
      const extraction = d.extraction as ExtractionResult;
      const ocrText: string | null = (d.ocr_raw_text as string | undefined) ?? null;
      const usedVisionFallback = outcome.attempts.length > 0 && outcome.attempts[outcome.attempts.length - 1].force_vision;
      const timing: PageTiming = {
        page_ms: pageMs,
        attempts: outcome.attempts,
        routing: (d as { routing?: { method?: string } }).routing?.method ?? null,
        needed_force_vision: usedVisionFallback,
        render: (d as { render?: unknown }).render,
        timing_ms: (d as { timing_ms?: unknown }).timing_ms,
        model_calls: (d as { model_calls?: unknown }).model_calls,
        qa: { fired: false, deferred: false },
      };

      // STRUCTURAL QA CHECK — RETRY REMOVED (2026-09-19). findStructuralIssues still runs and its flag is still
      // recorded in the page timing, but it no longer triggers a second read of the page. That retry (one bounded,
      // silent re-extraction, keeping whichever attempt had fewer flagged issues) never once changed a result in the
      // measured runs: on the one real document that trips it, the same single issue was flagged and the original was
      // kept every time (vision route 3/3, ~34 s each; tesseract route 6/6, ~10-12 s and ~9 relay calls each, ~30% of
      // that document's extraction time). Removed rather than gated by route, so nothing dead is left behind.
      const issues = findStructuralIssues(extraction);
      if (issues.length > 0) {
        timing.qa.issues_before = issues.length;
        timing.qa.skipped = "no_measured_benefit";
        console.log(`upload-resume: ${docId} page ${pn} flagged ${issues.length} structural issue(s), recorded; no retry — ${issues.join(" | ")}`);
      }

      const { error: ckErr } = await supabase.from("resume_extraction_pages")
        .upsert({ resume_document_id: docId, page_number: pn, extraction, ocr_text: ocrText, qa_retry: "not_needed", timing }, { onConflict: "resume_document_id,page_number" });
      if (ckErr) return await fail(500, { error: "checkpoint_failed", detail: ckErr.message, page: pn });
      rows.set(pn, { page_number: pn, extraction, ocr_text: ocrText, qa_retry: "not_needed", timing });
      if (pn === 1 && typeof d.page_count === "number" && d.page_count > 0) pageCount = d.page_count;
      await supabase.from("resume_documents").update({
        extraction_progress_at: new Date().toISOString(), extraction_stalls: 0,
        ...(pn === 1 && pageCount ? { extraction_page_count: pageCount } : {}),
      }).eq("id", docId);
      pageCosts.push(pageMs);
      console.log(`upload-resume: ${docId} page ${pn}/${pageCount ?? "?"} checkpointed — ${pageMs} ms in ${outcome.attempts.length} attempt(s), ${pageCalls} relay call(s) (${relayCalls} this invocation), routing=${timing.routing}`);
    }
  } catch (e) {
    // The invocation's own time budget ran out mid-page (or a call could not be completed). Everything already
    // checkpointed is kept; a fresh invocation picks up from the next missing page.
    console.log(`upload-resume: ${docId} invocation ended without finishing its page — ${String(e)}`);
    return await continueResponse();
  }

  // 2. Every page is checkpointed: merge and finalize.
  const total = Math.min(pageCount ?? 1, MAX_PDF_PAGES);
  const ordered = [...rows.values()].sort((a, b) => a.page_number - b.page_number);
  if (ordered.length < total) return await continueResponse();

  const merged = dedupePositions(mergeExtractions(ordered.map((r) => ({ pageNumber: r.page_number, extraction: r.extraction }))));
  // OCR text per page, in page order, with a marker so a person or a future tool can tell where a stretch came
  // from. A vision-routed page contributes no OCR text by architecture; its marker still shows the gap.
  const combinedOcrText = ordered.map((r) => `--- page ${r.page_number} ---\n` + (r.ocr_text ?? "(vision-routed page, no OCR text)")).join("\n\n");
  // Item 1 (2026-09-08 regression session): race-window fix — the candidate_id captured when the upload started can
  // be stale by the time extraction finishes (confirm-verification backfills it while pages are being read).
  // Re-reading it fresh, immediately before the insert, shrinks that window to one query.
  const { data: freshDocPdf } = await supabase.from("resume_documents").select("candidate_id").eq("id", docId).maybeSingle();
  const { error: pdfRpcErr } = await supabase.rpc("insert_resume_extraction", {
    p_resume_document_id: docId,
    p_candidate_id: freshDocPdf?.candidate_id ?? docMeta?.candidate_id ?? null,
    p_work_history: merged.work_history,
    p_education: merged.education,
    p_certifications: merged.certifications,
    p_skills: merged.skills,
    p_skills_position: merged.skills_position ?? null,
    p_skills_heading: merged.skills_heading || null,
    p_freeform: merged.freeform,
    p_ocr_text: combinedOcrText,
    p_candidate_location: merged.candidate_location || null,
    p_printed_header: merged.printed_header || null,
  });
  if (pdfRpcErr) return await fail(500, { error: "insert_failed", detail: pdfRpcErr.message });

  // Best-effort audit record of what the pipeline read off the document plus the per-page timing summary; the
  // extraction itself is already inserted above, so a failure here does not fail the upload.
  await supabase.from("resume_documents").update({
    ocr_raw_text: combinedOcrText,
    extraction_timing: { pages: ordered.map((r) => ({ page: r.page_number, ...(r.timing ?? {}) })), finished_at: new Date().toISOString() },
  }).eq("id", docId);

  const { error: pdfStatusErr } = await supabase.from("resume_documents")
    .update({ extraction_status: "extracted", extracted_at: new Date().toISOString(), extraction_lease_until: null }).eq("id", docId);
  if (pdfStatusErr) return jsonResponse({ ok: false, error: "status_update_failed", detail: pdfStatusErr.message }, 500);
  await supabase.from("resume_extraction_pages").delete().eq("resume_document_id", docId); // scratch space; best-effort

  const { data: signedPdf } = await supabase.storage.from(BUCKET).createSignedUrl(originalPath, 3600);
  return jsonResponse({
    ok: true,
    resume_document_id: docId,
    extraction_status: "extracted",
    extraction_method: "pdf_rasterize",
    page_count: pageCount ?? 1,
    original_signed_url: signedPdf?.signedUrl ?? null,
    continue: false,
    timing: { invocation_ms: Date.now() - invocationStart, pages: ordered.map((r) => ({ page: r.page_number, ...(r.timing ?? {}) })) },
  });
}

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (candidate-session pass, 2026-09-19).
// This function used to act on whatever candidate_id the request body named, with no check that the caller was that
// candidate (or anyone at all beyond holding the PUBLIC anon key), so anyone who knew or guessed an id could read or
// change that account. It now requires one of:
//   * the service-role key as the bearer token (our own functions calling each other; exact match, constant-time); or
//   * the candidate's OWN live session: the session_token candidate.html holds, checked on every call against
//     candidate_sessions (hashed, unrevoked, unexpired) and required to belong to the candidate_id being acted on.
// Anything else is the same 401 whether the token was missing, wrong, expired, revoked or someone else's.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
function authIsServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY);
}
async function authIsCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
  const r = await fetch(`${AUTH_SB_URL}/rest/v1/candidate_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
async function authGateCandidate(req: Request, body: any): Promise<Response | null> {
  const cid = typeof body?.candidate_id === "string" ? body.candidate_id : "";
  if (authIsServiceCaller(req)) return null;
  if (cid && await authIsCandidateSession(body, cid)) return null;
  return UNAUTHORIZED();
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const invocationStart = Date.now();
    try {
      const body = await req.json();
      // Continuation of a resumable PDF extraction: only the document id, no file bytes (see the RESUMABLE PDF
      // EXTRACTION header above). Anyone holding the (unguessable) id can only ask it to keep reading the file
      // that is already stored; it returns no extracted data.
      if (typeof body.resume_document_id === "string" && !body.original_base64) {
        if (!/^[0-9a-f-]{36}$/i.test(body.resume_document_id)) return jsonResponse({ ok: false, error: "resume_document_id_invalid" }, 400);
        return await continuePdfExtraction(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), body.resume_document_id, invocationStart);
      }
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
      // Candidate-session pass (2026-09-19): uploading into an existing account needs that candidate's own session.
      if (hasCand && !(authIsServiceCaller(req) || await authIsCandidateSession(body, candidate_id))) return UNAUTHORIZED();
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
      let resubClaim: { id: string; base: string | null } | null = null; // set when this upload is a resume resubmission (see the candidate_id branch)
      const releaseResubClaim = async () => {
        if (!resubClaim) return;
        await fetch(`${SUPABASE_URL}/rest/v1/resume_resubmissions?id=eq.${resubClaim.id}&resume_document_id=is.null&status=eq.extracting`, {
          method: "PATCH", headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "uploading", updated_at: new Date().toISOString() }),
        }).catch(() => {});
      };
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

        // Resume resubmission, Stage 1 (2026-09-21). An upload into an existing account used to be accepted whether or not the candidate had
        // already confirmed a resume, with no limit; confirm-resume-data would then happily confirm the second document and duplicate every item and
        // queue row. Now:
        //   * a candidate WITH a confirmed resume may only upload as a resubmission, through an open attempt that recorded the acknowledgement
        //     (resume-resubmission "start"), for a full_resume account; anything else is refused;
        //   * a candidate without one keeps the old "try a different file" behaviour, capped at 12 uploads per 24 hours (every upload costs a full
        //     extraction).
        const restRead = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
        const readRows = async (p: string): Promise<any[]> => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: restRead }); return r.ok ? await r.json() : []; };
        const confirmedDocs = await readRows(`resume_documents?candidate_id=eq.${candidate_id}&confirmed_at=not.is.null&select=id&order=confirmed_at.desc&limit=1`);
        const wantsResub = typeof body.resubmission_id === "string" && body.resubmission_id !== "";
        if (confirmedDocs.length && !wantsResub) {
          return new Response(JSON.stringify({ ok: false, error: "already_confirmed", message: "Your resume is already confirmed. Use Update my resume to submit a new one." }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (wantsResub) {
          if (!/^[0-9a-f-]{36}$/i.test(body.resubmission_id)) return jsonResponse({ ok: false, error: "resubmission_id_invalid" }, 400);
          const acct = (await readRows(`candidates?id=eq.${candidate_id}&select=account_type,deletion_scheduled_at`))[0];
          if (!acct || acct.account_type !== "full_resume" || acct.deletion_scheduled_at || !confirmedDocs.length) {
            return jsonResponse({ ok: false, error: "resubmission_not_allowed" }, 403);
          }
          // Claim the open attempt atomically (uploading -> extracting): two uploads can never both proceed for one acknowledgement.
          const claim = await fetch(`${SUPABASE_URL}/rest/v1/resume_resubmissions?id=eq.${body.resubmission_id.toLowerCase()}&candidate_id=eq.${candidate_id}&status=eq.uploading&resume_document_id=is.null`, {
            method: "PATCH", headers: { ...restRead, "Content-Type": "application/json", "Prefer": "return=representation" },
            body: JSON.stringify({ status: "extracting", updated_at: new Date().toISOString() }),
          });
          const claimed = claim.ok ? await claim.json() : [];
          if (!claimed.length) return jsonResponse({ ok: false, error: "resubmission_not_open" }, 409);
          resubClaim = { id: claimed[0].id, base: claimed[0].base_document_id };
        } else {
          const since = encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
          const recent = await readRows(`resume_documents?candidate_id=eq.${candidate_id}&uploaded_at=gt.${since}&select=id`);
          if (recent.length >= 12) return jsonResponse({ ok: false, error: "too_many_uploads", message: "Too many uploads today. Please try again tomorrow." }, 429);
        }
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
        await releaseResubClaim();
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
          ...(resubClaim ? { kind: "resubmission", supersedes_document_id: resubClaim.base } : {}),
          original_storage_path: originalPath,
          original_filename: original_filename ?? null,
          mime_type,
          sanitized_render_path: sanitizedPath,
          extraction_status: "pending",
          // The first run of a PDF holds the lease from the start (and counts as the first claim), so a
          // continuation call arriving early cannot start a second run against the same document.
          ...(isPdf ? { extraction_lease_until: new Date(Date.now() + EXTRACTION_LEASE_MS).toISOString(), extraction_stalls: 1 } : {}),
        })
        .select()
        .single();
      if (insertErr) {
        await releaseResubClaim();
        return new Response(JSON.stringify({ ok: false, error: "db_insert_failed", detail: insertErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (resubClaim) {
        await fetch(`${SUPABASE_URL}/rest/v1/resume_resubmissions?id=eq.${resubClaim.id}`, {
          method: "PATCH", headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ resume_document_id: docId, updated_at: new Date().toISOString() }),
        }).catch(() => {});
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
        console.log(`upload-resume: ${docId} is a PDF, routing through rasterize-pdf-page (resumable, checkpointed per page)`);
        return await processPdfPages(supabase, docId, originalPath, invocationStart);
      }

      const w = Number(width), h = Number(height);
      const aspectRatio = Math.max(w, h) / Math.min(w, h);
      const useVisionFallback = aspectRatio > STITCHED_ASPECT_RATIO_THRESHOLD;

      if (useVisionFallback) {
        console.log(`upload-resume: ${docId} routed to vision fallback (${w}x${h}, ratio ${aspectRatio.toFixed(2)})`);
        // STEP 1 OF 2 (Decision 38): section-boundary detection before the real extraction call.
        // Never allowed to fail the request — on failure, buildSectionBoundaryBlock's own
        // null-boundaries branch hands step 2 the old, pre-Decision-38 shape-based fallback instead.
        let sectionBoundaries: BoundaryResult | null = null;
        try {
          sectionBoundaries = await runBoundaryDetectionVision(sanitized_base64);
        } catch (boundaryErr) {
          console.log(`upload-resume: ${docId} boundary detection failed, falling back to shape-based classification — ${String(boundaryErr)}`);
        }
        let extraction: ExtractionResult;
        try {
          extraction = dedupePositions(await runVisionExtraction(sanitized_base64, sectionBoundaries));
          extraction.skills_heading = resolveSkillsHeading(sectionBoundaries, extraction);
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
          p_skills_heading: extraction.skills_heading || null,
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
