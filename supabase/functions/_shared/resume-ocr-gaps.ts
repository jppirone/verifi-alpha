// Unexplained-ink detector for tesseract-routed resume pages (2026-10-05, Lisa Tom resume).
//
// Why: tesseract's page layout analysis can silently DROP whole rows -- measured on the Lisa Tom resume, every
// "------- HEADING -------" row and the line right under one ("Bachelor of Science ...") came back with no words at all,
// 3 runs out of 3, while the same text was perfectly legible on the page. Nothing downstream can recover text the OCR
// never emitted, so the section headings and the Education entry vanished from the confirm screen and the generated PDF.
//
// What: after OCR, find rows of LETTER-LIKE ink that no recognised word covers. Those regions are cropped and read by a
// small vision call (resume-ocr-gap-transcribe in rasterize-pdf-page), and the result is added back as words. The page
// stays the only source of truth: nothing here reads the PDF text layer.
//
// How a region is decided (every number below was measured on the real resume corpus -- see tools/resume/measure-gaps.mjs
// and the 2026-10-05 report; the detector flags 5 regions on the Lisa Tom page, exactly its 5 lost rows, and 0 on the
// other 26 pages of the 6 reference documents plus 3 graphics-heavy stress pages):
//   1. ink = gray < 170 (the same threshold the strip planner already uses);
//   2. a recognised word explains the ink under its box, grown by WORD_PAD px. Confidence is deliberately NOT used:
//      correct words come back with confidence 0.02-0.15 ("Video", "Delivery"), so a confidence floor flagged 24
//      regions on the clean pages instead of 5;
//   3. the unexplained ink is grouped into rows; a row must be MIN_BAND_H..MAX_BAND_H px tall. Dashed/solid rules and
//      table borders are 1-4 px (too thin); photos, banners and large logos are taller than a text row (too tall);
//   4. inside a row, a column-run only counts as a letter stroke when it is >= MIN_LETTER_RUN_H px tall (a dashed rule
//      sitting beside a heading therefore never counts), runs closer than RUN_MERGE_GAP px merge into one region, and a
//      region needs >= MIN_RUNS letter strokes and >= MIN_REGION_W px (a stray bullet, page number or speck is ignored).

export interface OcrWordBox { text: string; left: number; right: number; top: number; bottom: number }
export interface GapRegion { x0: number; x1: number; y0: number; y1: number; runs: number }

export const GAP_PARAMS = {
  INK_MAX: 170,
  WORD_PAD: 4,
  BAND_GAP: 2,
  MIN_BAND_H: 9,
  MAX_BAND_H: 80,
  MIN_LETTER_RUN_H: 7,
  RUN_MERGE_GAP: 36,
  MIN_RUNS: 4,
  MIN_REGION_W: 50,
};
// More regions than this on one page means the OCR failed broadly, not that it dropped a few rows: the whole page goes to
// the vision path instead of being patched row by row.
export const MAX_GAP_REGIONS = 8;

// rgb: 3 bytes per pixel (mupdf's DeviceRGB pixmap), exactly what planOcrStrips reads. words: page-coordinate boxes.
export function findOcrGaps(rgb: Uint8Array, width: number, height: number, words: OcrWordBox[], p = GAP_PARAMS): GapRegion[] {
  const explained = new Uint8Array(width * height);
  for (const w of words) {
    if (!/[A-Za-z0-9]/.test(w.text)) continue; // a run of dashes / punctuation is not a recognised word
    const x0 = Math.max(0, Math.floor(w.left - p.WORD_PAD)), x1 = Math.min(width, Math.ceil(w.right + p.WORD_PAD));
    const y0 = Math.max(0, Math.floor(w.top - p.WORD_PAD)), y1 = Math.min(height, Math.ceil(w.bottom + p.WORD_PAD));
    if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) explained.fill(1, y * width + x0, y * width + x1);
  }
  const res = new Uint8Array(width * height);
  const bands: Array<[number, number]> = [];
  let start = -1, lastInk = -1;
  for (let y = 0; y <= height; y++) {
    let has = false;
    if (y < height) {
      const o = y * width;
      for (let x = 0; x < width; x++) if (rgb[(o + x) * 3] < p.INK_MAX && !explained[o + x]) { res[o + x] = 1; has = true; }
    }
    if (has) { if (start < 0) start = y; lastInk = y; }
    else if (start >= 0 && y - lastInk > p.BAND_GAP) { bands.push([start, lastInk + 1]); start = -1; }
  }
  const out: GapRegion[] = [];
  for (const [y0, y1] of bands) {
    const h = y1 - y0;
    if (h < p.MIN_BAND_H || h > p.MAX_BAND_H) continue;
    // letter strokes: x-runs of columns holding unexplained ink in this row, tall enough to be a glyph and not a rule
    const strokes: Array<[number, number, number, number]> = [];
    let runStart = -1, top = y1, bot = y0 - 1;
    for (let x = 0; x <= width; x++) {
      let colHas = false;
      if (x < width) for (let y = y0; y < y1; y++) if (res[y * width + x]) { colHas = true; if (y < top) top = y; if (y > bot) bot = y; }
      if (colHas) { if (runStart < 0) runStart = x; }
      else if (runStart >= 0) {
        if (bot - top + 1 >= p.MIN_LETTER_RUN_H) strokes.push([runStart, x, top, bot + 1]);
        runStart = -1; top = y1; bot = y0 - 1;
      }
    }
    let cur: GapRegion | null = null;
    const flush = () => { if (cur && cur.runs >= p.MIN_RUNS && cur.x1 - cur.x0 >= p.MIN_REGION_W) out.push(cur); cur = null; };
    for (const [a, b, t, bt] of strokes) {
      if (cur && a - cur.x1 < p.RUN_MERGE_GAP) { cur.x1 = b; cur.y0 = Math.min(cur.y0, t); cur.y1 = Math.max(cur.y1, bt); cur.runs++; }
      else { flush(); cur = { x0: a, x1: b, y0: t, y1: bt, runs: 1 }; }
    }
    flush();
  }
  return out;
}

// A transcription is only trusted when it is plausible for the ink it was read from: at least one letter or digit, and an
// average glyph width (region width / characters) that real 150 DPI body text can have. Anything else is dropped and the
// page simply keeps its original OCR (fail open) -- a wrong guess is worse than a missing row.
export function plausibleTranscription(text: string, region: GapRegion): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 2 || !/[A-Za-z0-9]/.test(t)) return false;
  const perChar = (region.x1 - region.x0) / t.length;
  return perChar >= 3 && perChar <= 60;
}

// Spreads a transcribed line across its region as word boxes (tokens get width in proportion to their length), so the
// existing word-clustering / column logic places it exactly like a recognised line at that position.
export function transcriptionToWords(text: string, region: GapRegion): Array<{ text: string; confidence: number; rect: { left: number; top: number; right: number; bottom: number } }> {
  const tokens = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const totalChars = tokens.reduce((s, t) => s + t.length, 0) + Math.max(0, tokens.length - 1);
  const span = region.x1 - region.x0;
  const out = [];
  let used = 0;
  for (const tok of tokens) {
    const left = region.x0 + (used / totalChars) * span;
    used += tok.length;
    const right = region.x0 + (used / totalChars) * span;
    used += 1;
    out.push({ text: tok, confidence: 0.9, rect: { left, top: region.y0, right, bottom: region.y1 } });
  }
  return out;
}

// What upload-resume stores in the page checkpoint (resume_extraction_pages.timing.ocr_gaps) so a recovered row can always be
// told apart from a row the OCR read itself: where each unexplained row was, what the vision crop read, and whether those words
// were added to the OCR text. Pure and size-bounded; null for a page with no gaps (its timing record is then unchanged).
export interface GapSummary {
  recovered_by: "vision_crop";
  detected: number; recovered_rows: number; injected_words: number; escalated_to_vision: boolean; error?: string;
  rows: Array<{ y0: number; y1: number; x0: number; x1: number; text: string | null; recovered: boolean }>;
}
const MAX_SUMMARY_ROWS = 16, MAX_SUMMARY_TEXT = 300;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
export function summarizeGapReport(raw: unknown): GapSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const detected = num(r.detected);
  if (detected <= 0 && typeof r.error !== "string") return null;
  const regions = Array.isArray(r.regions) ? r.regions : [];
  const out: GapSummary = {
    recovered_by: "vision_crop", detected, recovered_rows: num(r.transcribed), injected_words: num(r.injected_words), escalated_to_vision: r.escalated === true,
    rows: regions.slice(0, MAX_SUMMARY_ROWS).map((g) => {
      const x = (g ?? {}) as Record<string, unknown>;
      return { y0: num(x.y0), y1: num(x.y1), x0: num(x.x0), x1: num(x.x1), text: typeof x.text === "string" ? x.text.slice(0, MAX_SUMMARY_TEXT) : null, recovered: x.recovered === true };
    }),
  };
  if (typeof r.error === "string") out.error = r.error.slice(0, 300);
  return out;
}
