// FEASIBILITY TEST — can custom word-level clustering reconstruct correct column reading order
// from real Tesseract's own per-WORD coordinate data, entirely ignoring Tesseract's own block_num/
// par_num/line_num GROUPING decision (the thing proven wrong in test-real-tesseract-columns:
// block_num=4 merges "CONTACT" and "EXPERIENCE" onto one line)? Rationale: each individual
// recognized word box is still well-positioned even when the grouping built on top of those boxes
// is wrong — this is the same idea as test-tesseract-wasm-columns' getTextBoxes() approach, but
// that one failed because tesseract-wasm's LINE boxes were already pre-merged across columns
// before that code ever saw them (root cause, documented there). Real Tesseract's own TSV,
// requested at WORD granularity (level 5), does not have that problem: it never merges "CONTACT"
// and "EXPERIENCE" into one word, only into one line/block above the word level.
//
// Reuses the exact already-captured psm3.tsv from scripts/test-real-tesseract-columns/ (the
// original ruled-line image's real Tesseract run), read directly, NOT regenerated.
//
// Method: parse level-5 (word) rows only, drop blank-text placeholder words (Tesseract emits these
// for the horizontal rule under the header and the vertical divider line — not real content). Find
// the largest gap in sorted left-edge x-values to split words into two column clusters (equivalent
// to k=2 1D clustering on data this well-separated — no external clustering library needed here).
// Within each column, bucket words into lines by Y-proximity (6px tolerance) and sort each line's
// words by X. Concatenate: full left column top-to-bottom, then full right column top-to-bottom.
//
// RESULT — DOCUMENTED, MOSTLY POSITIVE, WITH TWO REAL NEW ARTIFACTS. Full captured output in
// reconstructed-output.txt. Checked against the real source content, not rounded up or down:
//
//   - Interleaving genuinely STOPS for the body content. "CONTACT" and "EXPERIENCE" land on
//     different lines in different columns (previously merged onto one line by Tesseract's own
//     grouping, in every prior test). The entire right (EXPERIENCE) column reads out in one
//     unbroken, correctly-ordered block, and so does the entire left (CONTACT/SKILLS/EDUCATION)
//     column.
//   - Both previously-MISSED-but-not-corrupted skills are now recovered CLEAN: "Go-to-Market
//     Strategy" and "Competitive Analysis" both come through as their own isolated lines — no
//     longer merged with unrelated right-column text ("Product Marketing Manager, Fieldstone
//     Software" / "'Aug 2016 - Dec 2019"), because that unrelated text is now correctly sorted
//     into the OTHER column entirely.
//   - The two FALSE POSITIVES flagged in the pattern-extraction test (right-column budget/pipeline
//     lines bleeding into what looked like the skills list) are also gone: "Managed $1.2M annual
//     marketing budget..." and "Grew qualified pipeline 35%..." now correctly sort into the right
//     column, nowhere near SKILLS.
//   - Character-level corruption from OCR itself is UNCHANGED and NOT recoverable by this or any
//     layout technique (expected, consistent with every prior test): "SQL, Tableau, Figma" still
//     reads "SL Tableau ... Figma" (SQL misrecognized); "Cross-functional Leadership" still lost
//     its middle word to OCR ("-functional" was recognized as "unetona", nothing to do with
//     layout).
//
//   Two REAL, NEW artifacts introduced by this technique itself, not glossed over:
//   1. The page HEADER ("TAYLOR MORGAN CHEN") spans the full page width, not two columns — but
//      blind x-only clustering doesn't know that, and splits it anyway: "TAYLOR MORGAN" (x=61,180)
//      falls left of the boundary, "CHEN" (x=315) falls right of it. It surfaces as "TAYLOR MORGAN"
//      at the top of column 0 and "CHEN" at the top of column 1 — a real fragmentation this
//      technique introduces for any full-width element, which a two-cluster-only model has no way
//      to represent correctly.
//   2. The single most heavily corrupted word box — Tesseract's OCR of "-functional", recognized
//      as "unetona" — has an unusually tall bounding box (height 35px vs ~9-11px for neighboring
//      words, confidence 29% by far the lowest of any word here) whose vertical center lands within
//      the 6px line-grouping tolerance of the SKILLS/Tableau line above it, not the Cross/Leadership
//      line it actually belongs to. Result: "SL Tableau unetona Figma" (contaminated by a misplaced
//      fragment) and "Cross Leadership" (missing its own corrupted middle word, displaced one line
//      up) — a real, new interleaving-adjacent defect this specific line-bucketing tolerance
//      produces on a badly-corrupted, oddly-boxed word. A tighter or adaptive tolerance might avoid
//      this specific case; not tried here, reported as-is.
//
// Tally against the 5 real, authored skill lines, this technique vs. the original SKILLS-header
// pattern-extraction test:
//   Clean & correctly isolated: 3 of 5 (Product Marketing; Go-to-Market Strategy — NEW; Competitive
//     Analysis — NEW). Previously only 1 of 5 was clean.
//   Still corrupted beyond recovery at the character level (unchanged, as expected): 2 of 5
//     (SQL/Tableau/Figma line, Cross-functional Leadership line) — but BOTH are now at least
//     correctly isolated from unrelated text; the corruption is now the only remaining problem,
//     not corruption plus merge.
//   False positives: 0 (down from 2). The isolation/merge failure mode that pattern-extraction
//     flagged is fully resolved by this technique.
//
// CONCLUSION: word-level coordinate clustering, entirely bypassing Tesseract's own broken grouping
// decision, is a genuinely more promising direction than anything tried before it tonight — it
// solves the interleaving/isolation problem completely for column body content. It does not, and
// cannot, fix character-level OCR corruption (never claimed to), and it introduces two of its own
// new, real artifacts (full-width-element fragmentation; one line-bucketing misplacement on a
// severely corrupted, oddly-sized word box) that a production version would need to handle
// deliberately, not something to claim as solved outright. Not built into any pipeline here —
// purely the feasibility read requested.

const fs = require("fs");

const tsvPath = "C:\\Users\\jpiro\\Verifi\\scripts\\test-real-tesseract-columns\\psm3.tsv";
const raw = fs.readFileSync(tsvPath, "utf8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);
const header = lines[0].split("\t");
const rows = lines.slice(1).map((l) => {
  const cols = l.split("\t");
  const o = {};
  header.forEach((h, i) => (o[h] = cols[i]));
  return o;
});

const words = rows
  .filter((r) => r.level === "5" && r.text.trim().length > 0)
  .map((r) => ({
    text: r.text,
    left: Number(r.left),
    top: Number(r.top),
  }));

console.log(`Total real word boxes: ${words.length}`);

const sortedLefts = [...words].sort((a, b) => a.left - b.left);
let maxGap = -1, gapIdx = -1;
for (let i = 1; i < sortedLefts.length; i++) {
  const gap = sortedLefts[i].left - sortedLefts[i - 1].left;
  if (gap > maxGap) {
    maxGap = gap;
    gapIdx = i;
  }
}
const boundary = (sortedLefts[gapIdx - 1].left + sortedLefts[gapIdx].left) / 2;
console.log(`Column boundary (largest x-gap): ${boundary} (gap of ${maxGap}px)`);

const col0 = words.filter((w) => w.left <= boundary);
const col1 = words.filter((w) => w.left > boundary);
console.log(`Column 0 (left): ${col0.length} words. Column 1 (right): ${col1.length} words.`);

function reconstructColumn(colWords) {
  const sorted = [...colWords].sort((a, b) => a.top - b.top);
  const linesOut = [];
  let current = [];
  let currentTop = null;
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
const reconstructed = col0Lines.join("\n") + "\n\n" + col1Lines.join("\n");

console.log("\n=== RECONSTRUCTED TEXT ===");
console.log(reconstructed);

fs.writeFileSync("reconstructed-output.txt", reconstructed + "\n");
console.log("\nWrote reconstructed-output.txt");
