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

export function isAtidLine(line: string): boolean {
  if (typeof line !== "string" || line.length > 60) return false;
  const m = ATID_LINE_RE.exec(line.trim());
  if (!m) return false;
  const body = m[2] + m[3] + m[4];
  // upper case letters and digits only, except the OCR-confusable lower case l, i, o
  if (!/^[0-9A-Zlio]{12}$/.test(body)) return false;
  const hasHyphen = /[\-‐-―−]/.test(m[1]);
  const hasDigit = /[0-9]/.test(body);
  return hasHyphen || hasDigit;
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
