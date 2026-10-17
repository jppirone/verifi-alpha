// One bucket per dated role (AP9, 2026-10-16, John's rule after the AP8 investigation).
//
// A job must fit one bucket (company, title, dates, responsibilities) so staff can confirm each role and period. The page
// extraction model decides this unreliably in both directions (PironeSimple: Thomson Reuters one header plus a dated
// progression note came back as two entries with a wrong 1997 start and the note line dropped; Aclarktest: WESTCX, a company
// line with two dated role blocks, came back as ONE entry titled "Recruiter to Senior Recruiter"). This module repairs exactly
// two text shapes from the page's OCR text, with no model call, and flags anything it cannot settle:
//
//   SHAPE 1 (dated roles under a company line). A company line (the employer's name as the page extraction printed it,
//     optionally with a short place and the overall years), followed in the same block by TWO OR MORE role lines. A role line
//     is: a title-shaped text (1 to 9 words, no digits, no sentence punctuation, not a bullet) immediately followed by a
//     FULL date range that ends the line ("Senior Recruiter, July 2024 August 2026"). Rules 1 and 2: one entry per role, the
//     company copied onto each, each role keeps its own title and dates, the company description goes on the latest role only,
//     the company line's own overall years are dropped. Bullets: taken from the model's merged text when it still carries a label
//     line for every role ("Recruiter, September 2023 - June 2024:"); when the role lines sit together with no text between them
//     the list is pooled and the latest role gets all of it, the other roles get empty responsibilities.
//   SHAPE 2 (one header plus a dated progression note). A header line holding the company and a full date range, followed within
//     three lines by a note of the form "Promoted/Advanced/Moved/... from <Title> (<full date range>)" or
//     "Previously/Formerly <Title> (<full date range>)". Rule 4: the header role keeps the title and dates printed on its header,
//     the note line is kept verbatim as the FIRST line of its responsibilities, the earlier role is its own entry (title from
//     the note, dates from the parentheses, empty responsibilities). Dates are only ever copied from the printed text.
//
// A prose progression line with no date range of its own (rule 3), a header with sub-groups of bullets (rule 7, the Donofrio
// shape), a "Role transition" caption (no "from <Title>" and no years) and two complete headers (the Indian River pair) match
// neither shape and are left exactly as extracted. Bullet lines, dates inside bullet text and Affiliations lists never match:
// a role or header line must not look like a bullet, must END with the date range, and must have a title-shaped front.
//
// When a shape IS present in the OCR text but the model's entries do not fit any pattern this module knows how to repair,
// nothing is changed and one "needs_review" free text entry holding the literal OCR lines is added (Decision 38).

export type RoleEntry = {
  company?: string;
  title?: string;
  location?: string;
  start_date?: string;
  end_date?: string;
  job_responsibilities?: string;
  heading?: string;
  position?: number;
  extraction_confidence?: string;
  [k: string]: unknown;
};
export type ReviewNote = { section_type: "needs_review"; heading: string; content: string; position?: number };
export type RoleBucketResult = { work_history: RoleEntry[]; needsReview: ReviewNote[]; actions: string[] };

const MONTH_NUM: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const POINT = `(?:${MONTH_RE}\\.?\\s+)?(?:19|20)\\d{2}`;
const END_POINT = `(?:${POINT}|present|current|now|today|ongoing)`;
const SEP = "\\s*(?:[-\\u2013\\u2014]|to|until)?\\s*";
const RANGE_AT_END = new RegExp(`^(.*?)[\\s,|:(]*(${POINT})${SEP}(${END_POINT})\\s*\\)?[.:]?$`, "i");
const RANGE_ONLY = new RegExp(`^\\s*(${POINT})${SEP}(${END_POINT})\\s*$`, "i");

type Point = { year: number; month: number | null } | "present";
export type Range = { start: Point; end: Point };

function parsePoint(s: string): Point | null {
  if (/^(present|current|now|today|ongoing)$/i.test(s.trim())) return "present";
  const m = s.match(new RegExp(`(?:(${MONTH_RE})\\.?\\s+)?((?:19|20)\\d{2})`, "i"));
  if (!m) return null;
  return { year: Number(m[2]), month: m[1] ? MONTH_NUM[m[1].slice(0, 3).toLowerCase()] : null };
}
export function fmtPoint(p: Point): string {
  if (p === "present") return "";
  return p.month ? `${p.year}-${String(p.month).padStart(2, "0")}` : String(p.year);
}
function samePoint(a: Point, b: Point): boolean {
  if (a === "present" || b === "present") return a === b;
  return a.year === b.year && (a.month ?? 0) === (b.month ?? 0);
}
function pointOrder(p: Point): number {
  return p === "present" ? 99999 : p.year * 12 + (p.month ?? 1);
}

const norm = (s: unknown): string => (typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]+/g, "") : "");

// A lone dash, dot or similar artifact line (the OCR often drops a dash onto its own line).
const LONE_ARTIFACT = /^\s*[-–—_.·•=~]{1,3}\s*$/;
// Anything that looks like the start of a bullet. Role lines and headers are never bullets.
const BULLET_LIKE = /^\s*(?:[©@«»•·*+¢■□▪●○◦]|[eo=~\-–—]\s|[eo]\s*=)/;
const SMALL_WORDS = new Set(["of", "and", "the", "for", "to", "in", "at", "a", "an", "&", "/", "-", "&amp;", "de", "or", "on", "with"]);

function cleanLines(ocr: string): string[] {
  return ocr.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "" && !LONE_ARTIFACT.test(l));
}

function titleShaped(t: string): boolean {
  const s = t.trim().replace(/[,|:;\-–—]+$/, "").trim();
  if (!s || s.length > 80 || /\d/.test(s) || /[.!?]$/.test(s) || /\s\|\s/.test(s) || s.includes("@")) return false;
  const words = s.split(/\s+/);
  if (words.length > 9) return false;
  return words.every((w) => /^[A-Z&(]/.test(w) || SMALL_WORDS.has(w.toLowerCase()));
}

function lineRange(line: string): { prefix: string; range: Range } | null {
  const m = line.trim().match(RANGE_AT_END);
  if (!m) return null;
  const a = parsePoint(m[2]), b = parsePoint(m[3]);
  if (!a || !b) return null;
  return { prefix: m[1].trim().replace(/[,|:;]+$/, "").trim(), range: { start: a, end: b } };
}

function isHeadingLine(l: string): boolean {
  const t = l.trim();
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && t.length <= 70 && t === t.toUpperCase() && !lineRange(t);
}

type RoleLine = { idx: number; title: string; range: Range };

function findCompanyLine(lines: string[], company: string): number {
  const nc = norm(company);
  if (!nc) return -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (BULLET_LIKE.test(l)) continue;
    const lr = lineRange(l);
    const rest = lr ? lr.prefix : l.trim();
    const nr = norm(rest);
    if (nr.startsWith(nc) && nr.length - nc.length <= 30 && !/\|/.test(rest)) return i;
  }
  return -1;
}

function findRoleLines(lines: string[], from: number, otherCompanies: string[]): RoleLine[] {
  const out: RoleLine[] = [];
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isHeadingLine(l)) break;
    const nl = norm(l);
    if (otherCompanies.some((c) => c && nl.startsWith(c) && (lineRange(l) || nl.length - c.length <= 30) && !BULLET_LIKE.test(l))) break;
    if (BULLET_LIKE.test(l)) continue;
    const lr = lineRange(l);
    if (!lr || !titleShaped(lr.prefix)) continue;
    out.push({ idx: i, title: lr.prefix.replace(/[,|:;\-–—]+$/, "").trim(), range: lr.range });
  }
  return out;
}

const SUBNOTE_FROM = /^(?:promoted|advanced|moved|transitioned|elevated|rose|progressed|started|joined|hired)\b.*?\b(?:from|as)\s+(?:an?\s+|the\s+)?([^()]+?)\s*\(([^()]*)\)\s*[.;]?$/i;
const SUBNOTE_PREV = /^(?:previously|formerly)\s*[:,]?\s*(?:an?\s+|the\s+)?([^()]+?)\s*\(([^()]*)\)\s*[.;]?$/i;

function parseSubnote(line: string): { title: string; range: Range } | null {
  const t = line.trim();
  if (BULLET_LIKE.test(t)) return null;
  const m = t.match(SUBNOTE_FROM) || t.match(SUBNOTE_PREV);
  if (!m) return null;
  const r = m[2].match(RANGE_ONLY);
  if (!r) return null;
  const a = parsePoint(r[1]), b = parsePoint(r[2]);
  if (!a || !b || a === "present") return null;
  const title = m[1].trim().replace(/[,;:]+$/, "").trim();
  if (!title || !titleShaped(title)) return null;
  return { title, range: { start: a, end: b } };
}

function sameRange(a: Range, b: Range): boolean {
  return samePoint(a.start, b.start) && samePoint(a.end, b.end);
}

// Label lines in the model's merged text ("Recruiter, September 2023 - June 2024:").
function labelLines(text: string, roles: RoleLine[]): Array<{ role: RoleLine; line: number }> | null {
  const tl = text.split("\n");
  const found: Array<{ role: RoleLine; line: number }> = [];
  for (const role of roles) {
    let at = -1;
    for (let i = 0; i < tl.length; i++) {
      const lr = lineRange(tl[i].replace(/:\s*$/, ""));
      if (lr && norm(lr.prefix) === norm(role.title) && sameRange(lr.range, role.range)) { at = i; break; }
    }
    if (at < 0) return null;
    found.push({ role, line: at });
  }
  return found.sort((a, b) => a.line - b.line);
}

function newEntry(base: RoleEntry, title: string, range: Range, text: string): RoleEntry {
  return { ...base, title, start_date: fmtPoint(range.start), end_date: fmtPoint(range.end), job_responsibilities: text };
}

function reviewNote(company: string, lines: string[], position?: number): ReviewNote {
  return { section_type: "needs_review", heading: `Check these roles at ${company}`, content: lines.map((l) => l.trim()).join("\n"), position };
}

// ORDER AND THE PAGE MERGE (AP9 phase D). The existing cross-page merge in upload-resume attaches text that continues on the next
// page to the LAST entry of the earlier page (by position, ties by array order). A repaired role group is therefore written in a
// MERGE-SAFE order: the role that would receive continuing text is LAST (Shape 1: the last printed role, or in a pooled list the
// role that holds the pooled text; Shape 2: the header role, the earlier role is written before it). Every entry of a repaired
// group gets the same position (so the array order decides) and a marker field _role_group. After the pages are merged,
// orderRoleGroupsLatestFirst puts each group in its final order, latest role first, and removes the marker.
export const ROLE_GROUP_KEY = "_role_group";

export function repairRoleBuckets(ocrText: string | null | undefined, workHistory: RoleEntry[], pageNumber = 0): RoleBucketResult {
  const res: RoleBucketResult = { work_history: workHistory.map((w) => ({ ...w })), needsReview: [], actions: [] };
  if (!ocrText || !workHistory.length) return res;
  let groupSeq = 0;
  const markGroup = (entries: RoleEntry[], position?: number) => {
    const id = `p${pageNumber}g${++groupSeq}`;
    for (const x of entries) { x[ROLE_GROUP_KEY] = id; if (typeof position === "number") x.position = position; }
  };
  const lines = cleanLines(ocrText);
  const companies: string[] = [];
  for (const w of workHistory) {
    const n = norm(w.company);
    if (n && !companies.includes(n)) companies.push(n);
  }
  for (const nc of companies) {
    const group = res.work_history.filter((w) => norm(w.company) === nc);
    if (!group.length) continue;
    const company = group[0].company as string;
    const others = companies.filter((c) => c !== nc);
    // ---- SHAPE 1: company line + two or more dated role lines
    const cl = findCompanyLine(lines, company);
    if (cl >= 0) {
      const roles = findRoleLines(lines, cl, others);
      if (roles.length >= 2) {
        const printed = [lines[cl], ...lines.slice(cl + 1)].slice(0, roles[roles.length - 1].idx - cl + 1);
        // The model already gave one entry per role title: nothing to repair.
        if (group.length >= roles.length && roles.every((r) => group.some((g) => norm(g.title) === norm(r.title)))) continue;
        if (group.length !== 1) { res.needsReview.push(reviewNote(company, printed, group[0].position)); res.actions.push(`${company}: ${roles.length} dated role lines, ${group.length} entries that do not fit, flagged`); continue; }
        const e = group[0];
        const text = typeof e.job_responsibilities === "string" ? e.job_responsibilities : "";
        const latest = [...roles].sort((a, b) => pointOrder(b.range.end) - pointOrder(a.range.end) || pointOrder(b.range.start) - pointOrder(a.range.start))[0];
        const labels = labelLines(text, roles);
        const consecutive = roles.every((r, i) => i === 0 || lines.slice(roles[i - 1].idx + 1, r.idx).length === 0);
        const built: RoleEntry[] = [];
        if (labels) {
          const tl = text.split("\n");
          const pre = tl.slice(0, labels[0].line).join("\n").trim();
          const blocks = new Map<RoleLine, string>();
          labels.forEach((lb, i) => blocks.set(lb.role, tl.slice(lb.line + 1, i + 1 < labels.length ? labels[i + 1].line : tl.length).join("\n").replace(/^\n+|\n+$/g, "")));
          for (const r of roles) {
            const body = blocks.get(r) || "";
            const full = r === latest && pre ? `${pre}\n${body}`.replace(/\n+$/, "") : body;
            built.push(newEntry(e, r.title, r.range, full));
          }
        } else if (consecutive) {
          // pooled list: the latest role holds all the text and is written LAST so continuing text on the next page joins it
          for (const r of roles) if (r !== latest) built.push(newEntry(e, r.title, r.range, ""));
          built.push(newEntry(e, latest.title, latest.range, text));
        } else {
          res.needsReview.push(reviewNote(company, printed, e.position));
          res.actions.push(`${company}: ${roles.length} dated role lines but no label lines in the entry text, flagged`);
          continue;
        }
        const at = res.work_history.indexOf(e);
        markGroup(built, e.position);
        res.work_history.splice(at, 1, ...built);
        res.actions.push(`${company}: split into ${built.length} entries (one per dated role)`);
        continue;
      }
    }
    // ---- SHAPE 2: header with company and a full date range + a dated "from <Title>" note
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (BULLET_LIKE.test(l) || !norm(l).includes(nc)) continue;
      const lr = lineRange(l);
      if (!lr) continue;
      let note: { title: string; range: Range } | null = null; let noteLine = "";
      for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
        if (BULLET_LIKE.test(lines[j])) break;
        const sn = parseSubnote(lines[j]);
        if (sn) { note = sn; noteLine = lines[j].trim(); break; }
      }
      if (!note) continue;
      const headTitle = (lr.prefix.includes("|") ? lr.prefix.split("|")[0] : lr.prefix.replace(new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "i"), "")).trim().replace(/[,|:;\-–—]+$/, "").trim();
      if (!headTitle || !titleShaped(headTitle)) continue;
      const printed = lines.slice(i, i + 3);
      const headerEntry = group.find((g) => norm(g.title) === norm(headTitle));
      const earlierEntry = group.find((g) => norm(g.title) === norm(note!.title));
      const hasNoteAlready = (t: string) => norm(t).includes(norm(noteLine));
      if (group.length === 2 && headerEntry && earlierEntry && headerEntry !== earlierEntry && !String(earlierEntry.job_responsibilities || "").trim()) {
        headerEntry.start_date = fmtPoint(lr.range.start); headerEntry.end_date = fmtPoint(lr.range.end);
        const t = String(headerEntry.job_responsibilities || "");
        if (!hasNoteAlready(t)) headerEntry.job_responsibilities = t ? `${noteLine}\n${t}` : noteLine;
        earlierEntry.start_date = fmtPoint(note.range.start); earlierEntry.end_date = fmtPoint(note.range.end);
        earlierEntry.job_responsibilities = "";
        // merge-safe order: the earlier role first, the header role LAST (continuing text on the next page belongs to the header role)
        const hi = res.work_history.indexOf(headerEntry), ei = res.work_history.indexOf(earlierEntry);
        if (ei > hi) { res.work_history.splice(ei, 1); res.work_history.splice(res.work_history.indexOf(headerEntry), 0, earlierEntry); }
        const pos = [headerEntry.position, earlierEntry.position].filter((p): p is number => typeof p === "number");
        markGroup([earlierEntry, headerEntry], pos.length ? Math.min(...pos) : undefined);
        res.actions.push(`${company}: split pair repaired from the printed header and note (dates and note line)`);
      } else if (group.length === 1 && headerEntry) {
        headerEntry.start_date = fmtPoint(lr.range.start); headerEntry.end_date = fmtPoint(lr.range.end);
        const t = String(headerEntry.job_responsibilities || "");
        if (!hasNoteAlready(t)) headerEntry.job_responsibilities = t ? `${noteLine}\n${t}` : noteLine;
        const at = res.work_history.indexOf(headerEntry);
        const earlier = newEntry(headerEntry, note.title, note.range, "");
        res.work_history.splice(at, 0, earlier); // merge-safe order: the earlier role before the header role
        markGroup([earlier, headerEntry], headerEntry.position);
        res.actions.push(`${company}: earlier role added from the dated note`);
      } else {
        res.needsReview.push(reviewNote(company, printed, group[0].position));
        res.actions.push(`${company}: dated progression note found but the entries do not fit, flagged`);
      }
      break;
    }
  }
  return res;
}

// Final order of a repaired role group, applied AFTER the pages are merged and the positions are numbered: latest role first
// (end date later first; an empty end date means "still ongoing" and sorts first; then later start first; a full tie keeps the
// written order). The group's entries swap their positions and their slots in the array, so nothing else moves. The marker
// field is removed here, so it never reaches the database.
function dateKey(s: unknown, ongoingIfEmpty: boolean): number {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return ongoingIfEmpty ? 1e9 : -1;
  const m = t.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return -1;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) : 6);
}

export function orderRoleGroupsLatestFirst<T extends RoleEntry>(workHistory: T[]): T[] {
  const out = [...workHistory];
  const groups = new Map<string, number[]>();
  out.forEach((w, i) => { const g = w[ROLE_GROUP_KEY]; if (typeof g === "string") groups.set(g, [...(groups.get(g) || []), i]); });
  for (const idx of groups.values()) {
    const entries = idx.map((i) => out[i]);
    const slotPositions = idx.map((i) => out[i].position);
    const ordered = entries
      .map((e, k) => ({ e, k }))
      .sort((a, b) => dateKey(b.e.end_date, true) - dateKey(a.e.end_date, true) || dateKey(b.e.start_date, false) - dateKey(a.e.start_date, false) || a.k - b.k)
      .map((x) => x.e);
    const slots = [...idx].sort((a, b) => a - b);
    ordered.forEach((e, k) => { out[slots[k]] = e; if (typeof slotPositions[k] === "number") e.position = [...slotPositions].filter((p): p is number => typeof p === "number").sort((a, b) => a - b)[k]; });
  }
  for (const w of out) delete (w as RoleEntry)[ROLE_GROUP_KEY];
  return out;
}
