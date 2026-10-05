// node tools/resume/test-resume-ocr-gaps.ts   (no dependencies; synthetic pages only -- the real-page measurements are in the 2026-10-05 report)
import assert from "node:assert/strict";
import { findOcrGaps, plausibleTranscription, transcriptionToWords, MAX_GAP_REGIONS } from "../../supabase/functions/_shared/resume-ocr-gaps.ts";

const W = 600, H = 400;
const blank = () => new Uint8Array(W * H * 3).fill(255);
const rect = (rgb: Uint8Array, x0: number, y0: number, w: number, h: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 3; rgb[i] = rgb[i + 1] = rgb[i + 2] = 0; } };
// a "word" of n glyph-like blocks, 10 px wide, 16 px tall, 16 px pitch
const glyphs = (rgb: Uint8Array, x: number, y: number, n: number) => { for (let i = 0; i < n; i++) rect(rgb, x + i * 16, y, 10, 16); return { x0: x, x1: x + n * 16 - 6, y0: y, y1: y + 16 }; };
const word = (text: string, g: { x0: number; x1: number; y0: number; y1: number }) => ({ text, left: g.x0, right: g.x1, top: g.y0, bottom: g.y1 });
let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };

t("blank page: nothing", () => assert.equal(findOcrGaps(blank(), W, H, []).length, 0));

t("a row of letter-like ink with no OCR word is one region, bounding the ink", () => {
  const p = blank(); const g = glyphs(p, 100, 50, 9);
  const r = findOcrGaps(p, W, H, []);
  assert.equal(r.length, 1); assert.deepEqual([r[0].x0, r[0].x1, r[0].y0, r[0].y1], [g.x0, g.x1, g.y0, g.y1]);
});

t("the same row covered by a recognised word is explained -- whatever the word's confidence", () => {
  const p = blank(); const g = glyphs(p, 100, 50, 9);
  assert.equal(findOcrGaps(p, W, H, [word("EDUCATION", g)]).length, 0);
});

t("a word made only of punctuation (a recognised dash run) does not explain letters under it", () => {
  const p = blank(); const g = glyphs(p, 100, 50, 9);
  assert.equal(findOcrGaps(p, W, H, [word("-----", g)]).length, 1);
});

t("heading row: dashed rules either side are ignored, the letters between them are the region", () => {
  const p = blank();
  for (let x = 20; x < 90; x += 8) rect(p, x, 58, 5, 2);        // left dashes (2 px tall)
  const g = glyphs(p, 150, 50, 8);
  for (let x = 300; x < 570; x += 8) rect(p, x, 58, 5, 2);       // right dashes
  const r = findOcrGaps(p, W, H, []);
  assert.equal(r.length, 1); assert.ok(r[0].x0 >= 150 && r[0].x1 <= g.x1 + 1, JSON.stringify(r[0]));
});

t("graphics are not flagged: rules, a solid bar, a tall photo-sized block, a lone bullet, a speck", () => {
  const p = blank();
  rect(p, 20, 20, 560, 2);        // solid rule
  rect(p, 20, 40, 300, 12);       // thick skill bar: one run, not letters
  rect(p, 400, 60, 120, 200);     // photo / logo block taller than a text row
  rect(p, 30, 300, 8, 8);         // bullet
  rect(p, 200, 330, 3, 3);        // speck
  assert.equal(findOcrGaps(p, W, H, []).length, 0);
});

t("a heading beside a photo-height band is deliberately not patched (documented limit)", () => {
  const p = blank(); glyphs(p, 100, 100, 9); rect(p, 400, 60, 120, 200); // photo shares the rows
  // rows 100-116 merge with the photo's rows into one 200 px band -> too tall -> skipped (fail open to the original OCR)
  assert.equal(findOcrGaps(p, W, H, []).length, 0);
});

t("two separate rows are two regions; more than MAX_GAP_REGIONS rows is detectable for page escalation", () => {
  const p = blank(); glyphs(p, 100, 50, 8); glyphs(p, 100, 120, 8);
  assert.equal(findOcrGaps(p, W, H, []).length, 2);
  const q = blank(); for (let i = 0; i < MAX_GAP_REGIONS + 1; i++) glyphs(q, 100, 10 + i * 40, 8);
  assert.equal(findOcrGaps(q, W, H, []).length, MAX_GAP_REGIONS + 1);
});

t("transcriptions: implausible text is rejected, plausible text becomes ordered words inside the region", () => {
  const region = { x0: 100, x1: 400, y0: 50, y1: 66, runs: 10 };
  assert.equal(plausibleTranscription("", region), false);
  assert.equal(plausibleTranscription("-----", region), false);
  assert.equal(plausibleTranscription("x".repeat(500), region), false);        // 0.6 px per character: not text that fits this ink
  assert.equal(plausibleTranscription("AREAS OF EXPERTISE", region), true);
  const w = transcriptionToWords("AREAS OF EXPERTISE", region);
  assert.deepEqual(w.map((x) => x.text), ["AREAS", "OF", "EXPERTISE"]);
  assert.ok(w[0].rect.left === 100 && w[2].rect.right === 400 && w[0].rect.right <= w[1].rect.left && w[1].rect.right <= w[2].rect.left);
  assert.ok(w.every((x) => x.rect.top === 50 && x.rect.bottom === 66));
});

console.log(`\n${n} tests passed`);
