// ATID (Applitrust ID) helpers shared by the Edge Functions (October 19, 2026).
//
// The SAME format as the SQL functions in supabase/migrations/20261019010000_atid.sql (atid_check_char, atid_valid_code, atid_is_stored,
// atid_display). tools/resume/atid-vectors.json is run against BOTH; if one side changes, the vector test fails on the other.
//   stored form    "ATID" + 11 random characters + 1 check character (16 characters)
//   displayed form "ATID-XXXX-XXXX-XXXX"
// The ATID is a pointer only. Nothing in this file authenticates anyone or looks anyone up, and stripATIDLines never reports the value it removed.

export const ATID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ATID_PREFIX = "ATID";

// the check character of an 11 character body (null when the body is not 11 characters of the alphabet)
export function atidCheckChar(body: string): string | null {
  if (typeof body !== "string" || !/^[0-9A-HJKMNP-TV-Z]{11}$/.test(body)) return null;
  let factor = 2, sum = 0;
  for (let i = 10; i >= 0; i--) {
    let add = factor * ATID_ALPHABET.indexOf(body[i]);
    factor = factor === 2 ? 1 : 2;
    add = Math.floor(add / 32) + (add % 32);
    sum += add;
  }
  return ATID_ALPHABET[(32 - (sum % 32)) % 32];
}

// is this 12 character code (body + check character) valid?
export function atidValidCode(code: string): boolean {
  if (typeof code !== "string" || !/^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)) return false;
  let factor = 1, sum = 0;
  for (let i = 11; i >= 0; i--) {
    let add = factor * ATID_ALPHABET.indexOf(code[i]);
    factor = factor === 2 ? 1 : 2;
    add = Math.floor(add / 32) + (add % 32);
    sum += add;
  }
  return sum % 32 === 0;
}

// the STORED form: ATID + 12 characters, check character fits
export function atidIsStored(value: unknown): boolean {
  return typeof value === "string" && /^ATID[0-9A-HJKMNP-TV-Z]{12}$/.test(value) && atidValidCode(value.slice(ATID_PREFIX.length));
}

// the DISPLAYED form ATID-XXXX-XXXX-XXXX; anything that is not a stored ATID comes back as it is
export function atidDisplay(value: string): string {
  if (!atidIsStored(value)) return value;
  return `${ATID_PREFIX}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}`;
}

// ---- typed text -> stored ATID (the employer lookup) ----------------------------------------------------------------------------------------
// The same rules as the KIO ID reader: any case; spaces, hyphens and dash variants ignored; I and L read as 1, O reads as 0 (the alphabet has none of them);
// the prefix with or without its hyphen, or no prefix at all when the 12 characters pass the check. A bad check character is refused HERE, before any
// database query. Result: {kind:"atid", stored, display} or {kind:"none", reason}. The reason is for tests only; callers must treat every "none" the same.
export type AtidReading = { kind: "atid"; stored: string; display: string } | { kind: "none"; reason: string };
export function atidNormalise(raw: unknown): AtidReading {
  if (typeof raw !== "string") return { kind: "none", reason: "type" };
  const s = raw.replace(/[ \t\r\n \-‐-―−]+/g, "").toUpperCase();
  if (s === "" || !/^[0-9A-Z]+$/.test(s)) return { kind: "none", reason: "characters" };
  const fold = (x: string) => x.replace(/[IL]/g, "1").replace(/O/g, "0");
  let body: string;
  if (s.length === 12 + ATID_PREFIX.length) {
    if (fold(s.slice(0, ATID_PREFIX.length)) !== fold(ATID_PREFIX)) return { kind: "none", reason: "no-prefix" };
    body = fold(s.slice(ATID_PREFIX.length));
  } else if (s.length === 12) {
    body = fold(s);
  } else {
    return { kind: "none", reason: "length" };
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return { kind: "none", reason: "alphabet" };
  if (!atidValidCode(body)) return { kind: "none", reason: "check" };
  const stored = ATID_PREFIX + body;
  return { kind: "atid", stored, display: atidDisplay(stored) };
}

// ---- the re-upload strip rule -------------------------------------------------------------------------------------------------------------
// A line that is ESSENTIALLY JUST an ATID (as printed by the candidate page, read back through OCR) is removed before the text reaches the
// boundary and extraction steps, so a resume that carries its own ATID line never gets it stored as content. Tolerances: the OCR confusions
// I / L / 1 and O / 0 (in the prefix and in the body), spaces, en/em dashes and minus signs for the hyphens. A longer sentence is never touched.
// The value is NEVER returned, logged or compared with anything: this helper cannot link an upload to an account.
//
//   (separator)  ATID  (separator)  4 chars (separator) 4 chars (separator) 4 chars
// To keep an ordinary line such as "ATID Core Team Lead" safe, a match needs EITHER a hyphen-like mark right after the prefix (the printed form
// always has one) OR at least one digit in the 12 characters; body characters are upper case letters and digits only (plus the OCR-confusable l, i, o).
const SEP = "[ \\t\\u00a0\\-\\u2010-\\u2015\\u2212_.]*";
const BODY_CH = "[0-9A-Za-z]";
const ATID_LINE_RE = new RegExp(
  "^[^0-9A-Za-z]*" + "[Aa][Tt][ILil1|!][Dd]" + "(" + SEP + ")" + "(" + BODY_CH + "{4})" + SEP + "(" + BODY_CH + "{4})" + SEP + "(" + BODY_CH + "{4})" + "[^0-9A-Za-z]*$",
);

// The 12 characters of an ATID-shaped line (as read, upper-cased, I and L as 1, O as 0), or null when the line is not one. isAtidLine is exactly "this is not null".
// It reads only the line it is given; it compares nothing and looks nothing up.
export function atidLineBody(line: string): string | null {
  if (typeof line !== "string" || line.length > 60) return null;
  const m = ATID_LINE_RE.exec(line.trim());
  if (!m) return null;
  const body = m[2] + m[3] + m[4];
  // upper case letters and digits only, except the OCR-confusable lower case l, i, o
  if (!/^[0-9A-Zlio]{12}$/.test(body)) return null;
  const hasHyphen = /[\-‐-―−]/.test(m[1]);
  const hasDigit = /[0-9]/.test(body);
  if (!(hasHyphen || hasDigit)) return null;
  return body.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
}
export function isAtidLine(line: string): boolean {
  return atidLineBody(line) !== null;
}

// text in, text out; `stripped` = how many lines were removed (never the value). Throws nothing it can avoid; the caller still wraps it (fail open).
export function stripATIDLines(text: string): { text: string; stripped: number } {
  if (typeof text !== "string" || text === "") return { text: typeof text === "string" ? text : "", stripped: 0 };
  const lines = text.split("\n");
  const kept: string[] = [];
  let stripped = 0;
  for (const l of lines) {
    if (isAtidLine(l)) { stripped++; continue; }
    kept.push(l);
  }
  return stripped === 0 ? { text, stripped: 0 } : { text: kept.join("\n"), stripped };
}

// ---- what an ATID found on an upload means (AU) ---------------------------------------------------------------------------------------------
// An ATID found on an uploaded resume is NEVER used as anything: not an identifier, not stored, not logged, not returned. The only thing anyone learns is one word:
//   "none"      no ATID line was on the upload
//   "match"     a line is the signed-in candidate's OWN ATID (read through OCR, so up to OWN_MATCH_MAX_DIFF characters of the 12 may be misread)
//   "mismatch"  anything else: another valid ATID, a made-up one, one with a bad check character, or an ATID on a first upload before any account exists
// The comparison is only ever against the candidate's own stored ATID, handed in by the caller. Nothing is looked up, so the word is the same for every wrong ID
// and says nothing about whose it is or whether it exists.
export type AtidFound = "none" | "match" | "mismatch";
export const OWN_MATCH_MAX_DIFF = 2;
function atidBodyMatchesOwn(detected12: string, own: unknown): boolean {
  if (!atidIsStored(own)) return false;
  const ownBody = (own as string).slice(ATID_PREFIX.length);
  let diff = 0;
  for (let i = 0; i < 12; i++) if (detected12[i] !== ownBody[i]) diff++;
  return diff <= OWN_MATCH_MAX_DIFF;
}
const worse = (a: AtidFound, b: AtidFound): AtidFound => (a === "mismatch" || b === "mismatch" ? "mismatch" : a === "match" || b === "match" ? "match" : "none");

// OCR text in; the same text without ATID-shaped lines, how many were removed, and the one-word result. Never returns the value.
export function classifyAtidLines(text: string, own: unknown): { text: string; stripped: number; found: AtidFound } {
  if (typeof text !== "string" || text === "") return { text: typeof text === "string" ? text : "", stripped: 0, found: "none" };
  const kept: string[] = [];
  let stripped = 0, found: AtidFound = "none";
  for (const l of text.split("\n")) {
    const body = atidLineBody(l);
    if (body === null) { kept.push(l); continue; }
    stripped++;
    found = worse(found, atidBodyMatchesOwn(body, own) ? "match" : "mismatch");
  }
  return stripped === 0 ? { text, stripped: 0, found: "none" } : { text: kept.join("\n"), stripped, found };
}

// The vision route and the image-vision path never see "text", only a model's extraction. Same rule, as post-processing on what came back (no model call, no prompt):
// every string anywhere in the extraction loses its ATID-shaped lines, a list entry that is just an ATID is dropped, and a freeform section left with nothing
// because of it is dropped. Edits the object in place; returns how many things were removed and the one-word result.
export function stripAtidFromExtraction(extraction: unknown, own: unknown): { stripped: number; found: AtidFound } {
  let stripped = 0, found: AtidFound = "none";
  const seen = (line: string): boolean => {
    const body = atidLineBody(line);
    if (body === null) return false;
    stripped++; found = worse(found, atidBodyMatchesOwn(body, own) ? "match" : "mismatch");
    return true;
  };
  const cleanString = (s: string): string => {
    if (!/[Aa][Tt][ILil1|!][Dd]/.test(s)) return s;   // cheap pre-check: no prefix, nothing to do
    const kept = s.split("\n").filter((l) => !seen(l));
    return kept.length === s.split("\n").length ? s : kept.join("\n");
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        if (typeof v[i] === "string") { const c = cleanString(v[i]); if (c === "" && v[i] !== "") v.splice(i, 1); else v[i] = c; }
        else walk(v[i]);
      }
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) { if (typeof o[k] === "string") o[k] = cleanString(o[k] as string); else walk(o[k]); }
    }
  };
  const ex = extraction as { freeform?: Array<{ heading?: string; content?: string }> } | null;
  const freeBefore = ex && Array.isArray(ex.freeform) ? ex.freeform.length : 0;
  walk(extraction);
  if (stripped > 0 && ex && Array.isArray(ex.freeform) && freeBefore > 0) {
    ex.freeform = ex.freeform.filter((f) => !(f && typeof f === "object" && !String(f.heading ?? "").trim() && !String(f.content ?? "").trim()));
  }
  return { stripped, found };
}
