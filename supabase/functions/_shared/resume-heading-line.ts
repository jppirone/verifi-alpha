// resume-heading-line (AW, October 20, 2026): the job heading exactly as the candidate's own resume printed it.
//
// John's rule: the generated PDF must not reorder, re-punctuate or reword anything a candidate put on the page. The structured fields (company, title, location, dates) are
// kept for the database, but the stored page text (resume_documents.ocr_raw_text, which is read by OCR only) still holds the heading line AS PRINTED. This finds it again, with
// a plain rule: no model, no prompt, no OCR change. Pure functions: no imports, no network, no database.
//
// A heading is found when a line (or two joined lines, or a title line followed by a company line) of the page text:
//   * contains the stored company, when there is one;
//   * contains the stored location, when there is one (so a place the candidate corrected on the confirm screen is never overwritten by an OCR misread);
//   * contains the stored start year and either the stored end year or Present/Current;
//   * contains the stored title, OR (when there is a company) is accepted on company + place + dates alone. In that case the PRINTED title wins over the stored one, so a compound
//     title the candidate did not write ("Recruiter to Senior Recruiter") is never printed.
// A row with no company (a title-first resume) needs the title and the dates.
// Anything else returns null and the caller falls back to the plain pipe heading. The OCR reading of a year range often drops the dash ("2019 2023"); a range that ends
// the heading with two bare years gets its dash back.

export type HeadingRow = { employer?: string | null; title?: string | null; location?: string | null; start?: string | null; end?: string | null; current?: boolean | null };

const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (d: unknown): string => { const m = /^(\d{4})/.exec(String(d ?? "")); return m ? m[1] : ""; };
// a leading OCR bullet glyph is not part of a heading
const clean = (s: string): string => s.replace(/^\s*[*+•·©»]\s+/, "").replace(/\s+$/, "").replace(/\s{2,}/g, " ");

// "... 2019 2023" and "... Jul 2024 Aug 2026)" and "... 2015 Present": the dash the OCR dropped between the two ends of a date range
export function restoreRangeDash(line: string): string {
  return line.replace(/(\b(?:[A-Za-z]{3,9}\.? )?\d{4}) ((?:[A-Za-z]{3,9}\.? )?\d{4}|Present|Current)(\)?)\s*$/, "$1 - $2$3");
}

function accepts(text: string, row: HeadingRow): { ok: boolean; titleSeen: boolean } {
  // a sentence is not a heading: headings end in a year, a bracket, a place or a title, never in a full stop after a word
  if (/[.!?]\s*$/.test(text.trim()) && text.trim().split(/\s+/).length >= 8) return { ok: false, titleSeen: false };
  const t = norm(text);
  const company = norm(row.employer), title = norm(row.title), loc = norm(row.location);
  const sy = yearOf(row.start), ey = yearOf(row.end);
  if (company && !t.includes(company)) return { ok: false, titleSeen: false };
  if (loc && !t.includes(loc)) return { ok: false, titleSeen: false };
  const years = t.split(" ");
  const hasYear = (y: string) => years.includes(y);
  if (sy && !hasYear(sy)) return { ok: false, titleSeen: false };
  if (row.current) { if (!/\b(present|current|now)\b/.test(t)) return { ok: false, titleSeen: false }; }
  else if (ey && !hasYear(ey)) return { ok: false, titleSeen: false };
  if (!sy && !ey && !row.current) return { ok: false, titleSeen: false };   // no dates at all: nothing to anchor on
  const titleSeen = !!title && t.includes(title);
  if (!company && !titleSeen) return { ok: false, titleSeen };           // a title-first row needs its title
  return { ok: true, titleSeen };
}

// The lines of the page text that are really text (the page markers are not).
function textLines(ocr: string): Array<{ i: number; s: string }> {
  const out: Array<{ i: number; s: string }> = [];
  String(ocr ?? "").split("\n").forEach((s, i) => { if (!/^---\s*page\s+\d+\s*---$/i.test(s.trim())) out.push({ i, s }); });
  return out;
}

// Returns the heading as printed (1 or 2 lines) and marks its lines as taken, or null. `used` is shared by all the rows of one document so two jobs never take the same line.
export function findPrintedHeading(ocr: string, row: HeadingRow, used: Set<number>): string[] | null {
  const L = textLines(ocr);
  const short = (s: string) => s.trim().length > 0 && s.length <= 200;
  for (let k = 0; k < L.length; k++) {
    const a = L[k];
    if (used.has(a.i) || !short(a.s)) continue;
    // 1. one line
    const one = clean(a.s);
    if (accepts(one, row).ok) { used.add(a.i); return [restoreRangeDash(one)]; }
    const b = L[k + 1];
    const next = b && !used.has(b.i) && short(b.s) && b.i === a.i + 1 ? b : null;
    // 2. the candidate printed the title on its own line and the company, place and dates on the next: both lines are the heading, in that order
    if (next && norm(row.employer) && norm(row.title) && norm(a.s).includes(norm(row.title)) && !norm(next.s).includes(norm(row.title))) {
      const second = clean(next.s);
      if (accepts(second, { ...row, title: "" }).ok) { used.add(a.i); used.add(next.i); return [clean(a.s), restoreRangeDash(second)]; }
    }
    // 3. the heading was broken across two lines by the page (or the OCR): join them back
    //    The first line must itself be the start of the heading (it holds the company, or the title for a title-first row) and the second must be only the tail (no company in it);
    //    otherwise a sentence just before a heading would be joined onto it.
    const startKey = norm(row.employer) || norm(row.title);
    if (next && next.s.trim().length <= 60 && startKey && norm(a.s).includes(startKey) && !norm(next.s).includes(startKey)) {
      const two = clean(a.s) + " " + clean(next.s).trimStart();
      if (accepts(two, row).ok && !accepts(one, row).ok) { used.add(a.i); used.add(next.i); return [restoreRangeDash(two)]; }
    }
  }
  return null;
}

// All the rows of one document, in the order the page printed them (position order), so equal-looking jobs are matched one to one.
export function attachPrintedHeadings<T extends HeadingRow & { id?: string; position?: number | null }>(rows: T[], ocrByRow: (row: T) => string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const usedByDoc = new Map<string, Set<number>>();
  const order = [...rows].sort((x, y) => (x.position ?? Infinity) - (y.position ?? Infinity));
  for (const r of order) {
    const ocr = ocrByRow(r);
    if (!ocr || !r.id) continue;
    // one `used` set per distinct page text
    const key = String(ocr.length) + ":" + ocr.slice(0, 40);
    if (!usedByDoc.has(key)) usedByDoc.set(key, new Set());
    const found = findPrintedHeading(ocr, r, usedByDoc.get(key)!);
    if (found) out.set(r.id, found);
  }
  return out;
}
