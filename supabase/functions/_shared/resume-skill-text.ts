// AP9O (Fix A of docs/ap9m-workplace-strengths-design.txt): put back the full text of a "title plus description" item that the
// extraction model shortened to its bare title because the boundary step labeled the section "skills".
//
// Why this exists: for a section labeled "skills" the extraction prompt tells the model to return short terms (rasterize-pdf-page,
// the skills definition and the "category is final" block), so a Workplace Strengths item such as "Strategic Thinking & Analytical
// Problem Solving, approaches challenges with a big-picture mindset ..." comes back as the title alone. The page's own OCR text still
// holds the whole item, so it is restored here from that text. No model call, no prompt change, no schema change.
//
// The rule is deliberately narrow so that a plain skills list is never touched (see test-resume-skill-text.ts):
//  1. A skill string S is "found" when an OCR line begins with S (an optional leading bullet or glyph is ignored) and S ends at a
//     word boundary of that line.
//  2. A found string is "extendable" when the rest of that same line, trimmed, starts with a LOWERCASE letter and is at least
//     MIN_REST_CHARS characters long (the start of a sentence-like description, not another column, a delimiter or a parenthetical).
//  3. The page is changed only when at least MIN_QUALIFYING strings are extendable AND they are at least MIN_QUALIFYING_SHARE of the
//     found strings.
//  4. An extendable string becomes S, then the rest of its line, then the following OCR lines up to the next found skill string, a
//     blank line, a section heading of the page, or MAX_CONTINUATION_LINES lines. A line that is only a dash (the OCR puts the dash of
//     "Title - description" on its own line) is not text: if one is present the item is written "Title <em dash> description", which is
//     the printed form.
// Every other string, and every page that does not pass the gate, is returned exactly as given (the same array object).
// Pure and synchronous. The caller wraps it in a fail-open try/catch (upload-resume): a throw means the page is used as the model gave it.

export const MIN_REST_CHARS = 25;
export const MIN_QUALIFYING = 2;
export const MIN_QUALIFYING_SHARE = 0.5;
export const MAX_CONTINUATION_LINES = 8;

const EM_DASH = String.fromCharCode(8212);
const DASH_ONLY_LINE = new RegExp("^[" + String.fromCharCode(8212) + String.fromCharCode(8211) + "-]{1,2}$");

export type SkillTextChange = { index: number; before: string; after: string };
export type SkillTextResult = { skills: string[]; changes: SkillTextChange[] };

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// The text of an OCR line after any leading bullet or glyph ("(c) ", "* ", "- ").
function stripLead(line: string): string {
  return line.replace(/^[^A-Za-z0-9]+/, "");
}

// The part of an OCR line after S, or null when the line does not begin with S at a word boundary.
function restAfter(line: string, s: string): string | null {
  for (const candidate of [line, stripLead(line)]) {
    if (candidate.startsWith(s)) {
      const rest = candidate.slice(s.length);
      if (rest === "" || /^\s/.test(rest)) return rest.trim();
    }
  }
  return null;
}

export function restoreSkillText(
  skills: unknown, ocrText: unknown, headings: unknown = [],
): SkillTextResult {
  const unchanged = { skills: skills as string[], changes: [] as SkillTextChange[] };
  if (!Array.isArray(skills) || skills.length === 0) return unchanged;
  if (typeof ocrText !== "string" || ocrText.trim() === "") return unchanged; // a vision routed page has no OCR text

  const lines = ocrText.split(/\r?\n/).map(norm);
  const headingSet = new Set(
    (Array.isArray(headings) ? headings : []).filter((h): h is string => typeof h === "string").map((h) => norm(h).toLowerCase()).filter(Boolean),
  );

  // find each string's line
  const found: Array<{ k: number; s: string; line: number; rest: string }> = [];
  for (let k = 0; k < skills.length; k++) {
    const raw = skills[k];
    if (typeof raw !== "string") continue;
    const s = norm(raw);
    if (!s) continue;
    for (let i = 0; i < lines.length; i++) {
      const rest = restAfter(lines[i], s);
      if (rest !== null) { found.push({ k, s, line: i, rest }); break; }
    }
  }
  if (found.length === 0) return unchanged;

  const extendable = found.filter((f) => f.rest.length >= MIN_REST_CHARS && /^[a-z]/.test(f.rest));
  if (extendable.length < MIN_QUALIFYING || extendable.length / found.length < MIN_QUALIFYING_SHARE) return unchanged;

  const anchorLines = new Set(found.map((f) => f.line));
  const out = skills.slice();
  const changes: SkillTextChange[] = [];
  for (const f of extendable) {
    const parts: string[] = [f.rest];
    let sawDash = false;
    for (let j = f.line + 1; j < lines.length && j <= f.line + MAX_CONTINUATION_LINES; j++) {
      const line = lines[j];
      if (line === "" || anchorLines.has(j) || headingSet.has(line.toLowerCase())) break;
      if (DASH_ONLY_LINE.test(line)) { sawDash = true; continue; }
      parts.push(line);
    }
    const after = f.s + (sawDash ? ` ${EM_DASH} ` : " ") + parts.join(" ");
    if (after === (skills[f.k] as string)) continue;
    changes.push({ index: f.k, before: skills[f.k] as string, after });
    out[f.k] = after;
  }
  if (changes.length === 0) return unchanged;
  return { skills: out, changes };
}
