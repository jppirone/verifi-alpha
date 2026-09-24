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
// STEP 1 OF 2: SECTION-BOUNDARY DETECTION — Decision 38 (2026-09-18), mirrored here from
// rasterize-pdf-page/index.ts (see that file's own header comment for the full root-cause story —
// this is the same fix, not a fresh design, applied to this function's single-call, single-document
// shape). No continuation-context concept exists in this function (one call, one already-complete
// OCR text, no page boundaries) — that's the one structural difference from rasterize-pdf-page's
// copy of this same mechanism, everything else is identical in spirit.
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

// Inline label + enumerated list as an undressed section boundary (2026-09-22 — a real, confirmed
// failure mode: a resume's Summary paragraph ended with "Experience Areas: o software development
// o technology infrastructure o ..." and the whole list landed as trailing Summary text instead of
// being split into skills, because it never looked like a heading — no standalone line, no blank-line
// break from the prose before it). Deliberately narrow and structural (glyph-pattern based, not a
// content-shape judgment) so it doesn't reopen the door Decision 38 closed on Step 2 re-judging
// category by shape — this only decides where one section ENDS and the next begins, never what's
// inside either one.
const INLINE_LABEL_LIST_BOUNDARY_RULE = `INLINE LABEL + LIST AS A SECTION BOUNDARY (a narrow, structural exception — most section boundaries
are ordinary standalone headings and need none of this): sometimes a document shifts from flowing prose
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

// Sub-entries inside a Projects/Portfolio-shaped section (2026-09-23 — a real, confirmed failure mode:
// an "AI PROJECTS & PORTFOLIO" section listing 4 distinct projects, each with its own bold project-name
// line, a tool-stack + date line under it, and its own bullet(s), came back shattered into several
// disconnected sections instead of staying one — several of the fragments lost their heading entirely
// ("Untitled section" in the UI) because only the FIRST project's name was treated as the section's real
// heading; each subsequent project's own bold name line was wrongly treated as a brand-new top-level
// section boundary of its own). This is the same visual shape work_history entries have (a bold/short
// title-like line, then a secondary line, then bullets) — which is exactly why it gets over-split the
// same way a resume's own company entries never do: those stay correctly grouped under ONE
// "Professional Experience" boundary because this pipeline already knows work_history sections contain
// multiple dated entries. A Projects/Portfolio-shaped section (or any additional_info-shaped section)
// needs the identical treatment.
const MULTI_ENTRY_SECTION_BOUNDARY_RULE = `MULTIPLE NAMED SUB-ENTRIES UNDER ONE SECTION (a narrow, structural exception, most relevant to
"Projects"/"Portfolio"-shaped sections but applicable to any section): once a real top-level heading has
opened a section, that section can legitimately contain SEVERAL parallel, individually-named sub-entries
under it — e.g. a "Projects" or "AI Projects & Portfolio" section listing 4 separate projects, each with
its own bold project-name line, its own secondary line (tools used, a date range), and its own bullet(s)
describing it. This is structurally the same pattern work_history sections already have (one heading,
several dated company/title entries under it) — treat it the same way: the section's own top-level
heading (e.g. "AI Projects & Portfolio") stays the ONE section boundary and category decision for the
WHOLE block; a subsequent project's own bold name line is part of that SAME section's content, never a
new section boundary of its own, even though it visually resembles a heading. Judge this structurally:
a short bold line immediately followed by a secondary line (tools/dates) and then bullet(s), appearing
after an already-open section with no unrelated topic shift, is a sub-entry of that open section, not a
new section — this holds no matter how many sub-entries follow one after another. Only a line that is
clearly a DIFFERENT, unrelated section's own heading (a genuinely new topic, e.g. "PROFESSIONAL
EXPERIENCE" appearing after a Projects section) ends the current section and starts a new one.`;

type BoundaryCategory = "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "additional_info" | "unknown";

type BoundarySection = { heading: string; category: BoundaryCategory };

// noMergeCompanies / mergeCompanies (2026-09-23): a SAME COMPANY, MULTIPLE ROLES merge decision the
// main extraction step kept getting wrong even after three prose-only attempts at the "don't merge"
// direction (the model kept merging two independently, fully-headed same-company entries whenever one
// carried a promotion/transition caption, no matter how explicitly the prose said not to). Adding
// noMergeCompanies alone then exposed the SAME unreliability from the other side: a genuine Shape-A
// case (Thomson Reuters — one real header, one subordinate promotion note) that had been merging
// correctly stopped reliably reaching the merge step once it was left to the model's own prose gating
// test rather than a fixed answer — the prose was never actually reliable, earlier tests just hadn't
// exposed it yet. Both directions are decided HERE instead, deterministically, by this separate,
// focused boundary-detection call — same philosophy as every other field in this block: the extraction
// step is told the already-final answer for every company that has one, not asked to re-derive it
// while busy with everything else. A company can appear in AT MOST one of the two lists. A company not
// in either list (rare — this call found no clear signal) falls back to the ordinary HOW-TO-MERGE /
// gating-test prose in the extraction prompt.
type BoundaryResult = { sections: BoundarySection[]; noMergeCompanies?: string[]; mergeCompanies?: string[] };

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
    { "heading": string, "category": "work_history" | "education" | "certifications" | "skills" | "summary" | "hobbies_other" | "additional_info" | "unknown" }
  ],
  "noMergeCompanies": [ string ],
  "mergeCompanies": [ string ]
}`;

function buildBoundaryDetectionPrompt(ocrText: string): string {
  return `You are analyzing the raw OCR text of a resume to identify its section boundaries only — not
to extract any data yet. The OCR text below may contain recognition errors (misread characters, words
glued together, minor garbling); read through that when identifying headings.

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

${INLINE_LABEL_LIST_BOUNDARY_RULE}

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

${BOUNDARY_SCHEMA_SHAPE}

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
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
hobbies_other — see the KNOWN INTERNAL CATEGORIES guide above for the full list). For genuinely
headerless content, fall back further to judging by its own shape — the same fallback described in
"THE ONE EXCEPTION" above, just applied to the whole document rather than one flagged section, since
no per-section decision exists this time. A header that matches none of the above goes to
needs_review, same as always.`;
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
  // SAME COMPANY, MULTIPLE ROLES (2026-09-23): decided HERE too, same reasoning as the skills_secondary
  // case above — three prose-only attempts inside the main extraction prompt could not reliably stop
  // the model from merging two independently, fully-headed same-company entries whenever a promotion
  // or transition caption was present. Rendered as a fixed, per-company "already decided" instruction
  // instead of asking the model to run a gating test itself mid-extraction.
  // Both directions decided deterministically (2026-09-23) — the merge-eligible direction turned out
  // to need this just as much as the don't-merge direction: a genuine Shape-A company (one real
  // header, one subordinate promotion note) stopped reliably reaching HOW TO MERGE once left to the
  // model's own prose gating test, the exact same "prose rule the model has to notice" unreliability
  // this whole mechanism exists to route around, just exposed from the other side once noMergeCompanies
  // alone took the doNotMerge decision away from that same unreliable test.
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

async function runBoundaryDetection(ocrText: string): Promise<BoundaryResult> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1536,
      temperature: 0,
      messages: [{ role: "user", content: buildBoundaryDetectionPrompt(ocrText) }],
    }),
  });
  if (!claudeRes.ok) {
    const detail = await claudeRes.text().catch(() => "");
    throw new Error(`claude_call_failed (${claudeRes.status}): ${detail.slice(0, 500)}`);
  }
  const claudeData = await claudeRes.json();
  const rawText: string = claudeData?.content?.find((b: { type?: string }) => b.type === "text")?.text ?? "";
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

function buildExtractionPrompt(ocrText: string, sectionBoundaries?: BoundaryResult | null): string {
  return `You are extracting structured data from the raw OCR text of a resume. The OCR text below
may contain recognition errors (misread characters, words glued together, minor garbling) — do
your best to read through that, but do not invent information that is not actually present in the
text in some recognizable form.

Return ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
  "candidate_location": string,
  "candidate_phone": string,
  "candidate_email": string,
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

- "candidate_phone" and "candidate_email" (top-level, not inside any category, 2026-09-23) = the
  candidate's OWN phone number and email address, exactly as printed on their name/contact line —
  the same header line candidate_location and printed_header both read from. Copy each verbatim, in
  whatever format the resume actually prints it (e.g. "732-804-4973", "(219) 204-2607",
  "+1 201-446-6784" for phone; "jpirone@yahoo.com" for email) — never reformat, normalize, add or
  remove punctuation, or guess a missing country code. These are a SIBLING pair to
  candidate_location, structured out of the same header line for the same reason: printed_header
  captures the whole block verbatim for display, but a phone number and email address are each
  their own genuinely useful structured fact on their own, the same way candidate_location already
  is. Use an empty string "" for either one when the resume genuinely doesn't print it anywhere —
  never infer, guess, or reconstruct one, and never copy a DIFFERENT phone/email printed elsewhere
  on the resume (e.g. inside a work_history entry, or a reference's contact info) into these
  fields — only the candidate's OWN header-line phone/email count.

- "printed_header" (top-level, not inside any category) = the ENTIRE personal-info header block
  exactly as printed at the top of the resume — the candidate's own name (including any middle
  initial, suffix like "Jr." or "Sr.", or professional qualifier like "Esq." or "PE", exactly as
  printed, in whatever order and case it appears), plus every contact/location line printed
  alongside it (phone, email, mailing address, city/state, LinkedIn URL, etc.). Captured as ONE
  literal block of text — never parsed into separate name/phone/email/location parts by YOU editing
  or shortening it, unlike candidate_location/candidate_phone/candidate_email above, which each stay
  their own separate, structured field for exactly that one piece — extracting those structured
  fields is an ADDITIONAL, SEPARATE operation from capturing this one, not an alternative to it; do
  both, the same way certifications' "heading" and "issuing_body" both get extracted from one shared
  heading line. Preserve the resume's own line breaks using "\n" between them; copy every character
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
  section with no such identifier at all. When that specific mix occurs inside such a section, use the
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
  "content" (see the PROJECTS/MULTI-ENTRY SECTIONS rule below for sections containing several named
  sub-entries) — do not shorten, summarize, or drop any of it. A section only gets "additional_info"
  when its own real header clearly matches one of these recognizable patterns; a header that is vague,
  ambiguous, or doesn't fit even loosely still goes to "needs_review" instead — this category is for
  clearly-recognizable common section types only, never a second general catch-all.

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

DATES: write every date exactly as precisely as the resume prints it, never more precisely. Use YYYY
when the resume gives only a year, YYYY-MM when it gives a month and year, and YYYY-MM-DD only when it
gives a specific day (rare). NEVER fill in a month or day the resume does not show: a bare "2019" is
"2019", not "2019-01" and not "2019-01-01". If a role/program is current/ongoing ("Present", "Current",
"Now"), write the word Present as its end_date. If a date is entirely absent or unrecoverable, use an
empty string "" for that field, not a guess.

If a category has no entries, return an empty array for it — do not omit the key.${buildSectionBoundaryBlock(sectionBoundaries)}

--- BEGIN RESUME OCR TEXT ---
${ocrText}
--- END RESUME OCR TEXT ---`;
}

type ExtractionResult = {
  candidate_location?: string;
  candidate_phone?: string;
  candidate_email?: string;
  printed_header?: string;
  work_history: Array<{ company: string; title: string; location?: string; start_date: string; end_date: string; job_responsibilities: string; extraction_confidence: string; position?: number; heading?: string }>;
  education: Array<{ institution: string; degree: string; field_of_study: string; location?: string; start_date: string; end_date: string; extraction_confidence: string; position?: number; heading?: string }>;
  certifications: Array<{ name: string; issuing_body: string; license_number?: string; issue_date: string; expiration_date: string; extraction_confidence: string; position?: number; heading?: string }>;
  skills: Array<string>;
  skills_heading?: string;
  skills_position?: number | null;
  freeform: Array<{ section_type: string; heading: string; content: string; position?: number }>;
};

// Item B (2026-09-13 PDF-regression follow-up session): server-side, deterministic replacement for
// the earlier prompt-only "ensure positions are genuinely unique" instruction. Confirmed via a real
// re-test against the same source document that the prompt wording had ZERO effect: the exact same
// 4 certifications still came back sharing one position value, identical to before that instruction
// was added — LLM self-compliance on a positional-uniqueness constraint isn't reliable and this
// stops relying on it. Instead, every position-bearing item across every category, PLUS the single
// skills-block position, is collected, sorted by its extracted position (ties broken by original
// emission order, preserving a tied group's relative order rather than randomizing it), and
// renumbered to strictly increasing integers in that same relative order. This can never leave two
// items sharing a position, and never changes the relative ordering the extraction actually
// produced — it only removes ties. See upload-resume's own copy of this function for the fuller
// investigation notes (this path — extract-resume-fields, single-shot OCR-text extraction — has no
// per-page merge step to run before it, so unlike upload-resume's PDF branch this can run directly
// on the parsed result).
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

      // STEP 1 OF 2 (Decision 38): section-boundary detection, one extra call before the real
      // extraction call below. Never allowed to fail the request — it's a genuine accuracy
      // improvement over the old one-call design, not a new hard dependency; on failure,
      // buildSectionBoundaryBlock's own null-boundaries branch hands step 2 the old,
      // pre-Decision-38 shape-based fallback instead.
      let sectionBoundaries: BoundaryResult | null = null;
      try {
        sectionBoundaries = await runBoundaryDetection(doc.ocr_raw_text);
      } catch (boundaryErr) {
        console.log(`extract-resume-fields: boundary detection failed, falling back to shape-based classification — ${String(boundaryErr)}`);
      }

      const prompt = buildExtractionPrompt(doc.ocr_raw_text, sectionBoundaries);

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

      dedupePositions(parsed);
      parsed.skills_heading = resolveSkillsHeading(sectionBoundaries, parsed);
      const { error: rpcErr } = await supabase.rpc("insert_resume_extraction", {
        p_resume_document_id: resume_document_id,
        p_candidate_id: currentCandidateId,
        p_work_history: parsed.work_history,
        p_education: parsed.education,
        p_certifications: parsed.certifications,
        p_skills: parsed.skills,
        p_skills_position: parsed.skills_position ?? null,
        p_skills_heading: parsed.skills_heading || null,
        p_freeform: parsed.freeform,
        // This path only ever runs once real OCR text exists — extraction_status must already be
        // 'ocr_done' to reach here at all (see the check above) — so doc.ocr_raw_text (already
        // fetched) is real, not a guess, and already the exact same text this document's own
        // extraction was performed against. Bug-2 defense-in-depth: see the migration that added
        // certification_source_match for why this is being threaded through now.
        p_ocr_text: doc.ocr_raw_text,
        p_candidate_location: parsed.candidate_location || null,
        p_printed_header: parsed.printed_header || null,
        p_candidate_phone: parsed.candidate_phone || null,
        p_candidate_email: parsed.candidate_email || null,
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
