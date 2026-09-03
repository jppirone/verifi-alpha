// FEASIBILITY TEST — follow-up to the tesseract-wasm column-detection dead end
// (test-tesseract-wasm-columns: getTextBoxes()-based column reordering doesn't work because the
// per-line boxes are already merged across columns at the source, before this code ever runs).
// Question: even though full-document reading order is unrecoverable, can targeted PATTERN-based
// extraction still pull specific fields out of the garbled text directly, without ever needing
// correct reading order?
//
// Reuses the exact same captured baselineText from test-tesseract-wasm-columns's real deployed
// run against the two-column resume test image — pasted verbatim below, NOT regenerated — so this
// is a controlled comparison against already-documented output, not a fresh/different OCR pass.
// Pure local Node script: no Deno, no Supabase, no deployment. Analysis only.
//
// Two techniques tested, per instructions:
//   1. Easy case — email extraction via a standard regex pattern anchor, straight against the raw
//      garbled text.
//   2. Harder case — SKILLS-header-triggered token extraction: locate "SKILLS" in the raw text,
//      treat everything up to the next section header as an unordered list of short tokens, split
//      on comma / newline / bullet(~) / run-of-whitespace, WITHOUT assuming reading order.
// Explicitly out of scope (per instructions): no attempt to fix job-title/company extraction, no
// wiring this into any real pipeline. Purely a feasibility read on these two techniques against
// real captured data.
//
// RESULT — DOCUMENTED, MIXED. Two very different outcomes:
//
//   CASE 1 (email): YES, reliably. Single clean match, "taylor.chen@example.com", correctly
//   isolated out of the fully merged line "taylor.chen@example.com Senior Product Marketing
//   Manager, Nimbus Cloud Co" — none of the trailing unrelated text leaked into the match. A
//   tightly-shaped pattern (has a fixed @/domain/TLD structure) terminates itself correctly
//   regardless of what garbage surrounds it.
//
//   CASE 2 (skills): weighed against the 5 real, authored skill lines (Product Marketing /
//   Go-to-Market Strategy / Competitive Analysis / SQL, Tableau, Figma / Cross-functional
//   Leadership), the comma/newline/bullet/whitespace split produced 8 tokens:
//     - 1 of 5 recovered CLEAN: "Product Marketing" (isolated on its own line, exact match).
//     - 2 of 5 MISSED — present verbatim but glued to unrelated text with no delimiter between
//       them, so the split rule can't isolate them: "Go-to-Market Strategy" (glued to "Product
//       Marketing Manager"), "Competitive Analysis" (glued to "'Aug 2016 - Dec 2019").
//     - 2 of 5 CORRUPTED beyond recovery — at least one real word misrecognized at the character
//       level, which no pattern rule can fix: "SQL, Tableau, Figma" line came out "Sel Tableau
//       Fisma..." (SQL→Sel, Figma→Fisma; Tableau itself is spelled right but still unisolable);
//       "Cross-functional Leadership" line came out "Cross unctona Leadership..." (the hyphen and
//       several letters of "functional" are gone).
//     - PLUS 2 FALSE POSITIVES not counted in the 5-item tally above: the token immediately after
//       "SKILLS" ("Managed $1.2M annual marketing budget across 3 product lines") and one later
//       token ("Grew qualified pipeline 35% through targeted campaign work") are both real right-
//       column content that a naive "everything after SKILLS" rule would wrongly ingest as if they
//       were skills. This is a distinct correctness risk from the recovery/miss/corruption tally —
//       not just missing data, but actively wrong data.
//
// Conclusion: pattern extraction rescues data with a distinctive, self-terminating SHAPE (email,
// likely also phone numbers/dates/URLs) regardless of surrounding corruption. It does not rescue
// short bare phrases with no structural signal (skill names) — those have nothing to anchor on
// and stay merged with whatever unrelated text sits next to them in the corrupted layout. Not
// built into any pipeline; no attempt made to fix job-title/company extraction — purely the
// feasibility read requested.

const RAW_TEXT = `TAYLOR MORGAN CHEN

Product Marketing Manager

CONTACT EXPERIENCE
taylor.chen@example.com Senior Product Marketing Manager, Nimbus Cloud Co
(555) 402-7731 Jan 2020 - Present
‘Austin, TX - Launched 4 major product releases, exceeding adoption targets

~ Built competitive intelligence program adopted company-wide
SKILLS ~ Managed $1.2M annual marketing budget across 3 product lines
Product Marketing
Go-to-Market Strategy Product Marketing Manager, Fieldstone Software
Competitive Analysis ‘Aug 2016 - Dec 2019
Sel Tableau Fisma Developed positioning and messaging for Nagship SaaS product
Cross unctona Leadership “Partnered with sales fo buld enablement materials and training

~ Grew qualified pipeline 35% through targeted campaign work

EDUCATION Marketing Associate, Fieldstone Software
BA Marketing Jun 2016 - Aug 2016
Riverbend College, 2016 - Supported content marketing and social media calendar
`;

console.log("=== CASE 1: Email extraction (pattern anchor) ===");
const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const emails = RAW_TEXT.match(emailRe) || [];
console.log("Matches found:", JSON.stringify(emails));
const line = RAW_TEXT.split("\n").find((l) => l.includes("@"));
console.log("Full raw line it was embedded in:", JSON.stringify(line));
console.log();

console.log("=== CASE 2: Skills-header-triggered token extraction ===");
const skillsIdx = RAW_TEXT.indexOf("SKILLS");
console.log("'SKILLS' header found at index:", skillsIdx, skillsIdx >= 0 ? "(present, spelled correctly)" : "(NOT FOUND)");

const nextHeaderIdx = RAW_TEXT.indexOf("EDUCATION", skillsIdx);
const skillsBlock = RAW_TEXT.slice(skillsIdx + "SKILLS".length, nextHeaderIdx);
console.log("\nRaw text between 'SKILLS' and next header 'EDUCATION':");
console.log(JSON.stringify(skillsBlock));

// The rule as specified: split on variable whitespace / commas / bullets, no reading-order
// assumption.
const tokens = skillsBlock
  .split(/[,\n~]|(?:\s{2,})/)
  .map((t) => t.trim())
  .filter((t) => t.length > 0);
console.log("\nTokens produced by the split rule (comma / newline / bullet(~) / big-whitespace):");
tokens.forEach((t, i) => console.log(`  [${i}] ${JSON.stringify(t)}`));

console.log("\n--- Ground truth: the 5 real skill lines as authored ---");
const realSkills = ["Product Marketing", "Go-to-Market Strategy", "Competitive Analysis", "SQL, Tableau, Figma", "Cross-functional Leadership"];
realSkills.forEach((s) => console.log("  -", s));

// Final tally (see header comment for the reasoning behind each classification):
console.log("\n--- Final tally against the 5 real skill lines ---");
console.log("Clean:      1/5 (Product Marketing)");
console.log("Missed:     2/5 (Go-to-Market Strategy, Competitive Analysis — present verbatim, unisolable)");
console.log("Corrupted:  2/5 (SQL/Tableau/Figma line, Cross-functional Leadership line — char-level errors)");
console.log("False positives (not skills, would be wrongly ingested as skills): 2");
console.log("  - \"Managed $1.2M annual marketing budget across 3 product lines\"");
console.log("  - \"Grew qualified pipeline 35% through targeted campaign work\"");
