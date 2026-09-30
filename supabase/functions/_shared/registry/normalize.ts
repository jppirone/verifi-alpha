// Normalization helpers shared by every registry / license adapter: dates, strings, person-name handling, and the status
// rules. The status rules were written against the REAL distinct values each source publishes (queried live 2026-09-30),
// not guessed; the test in tools/registry prints every observed raw value next to what it normalizes to so a reviewer can
// eyeball the whole table. The source's own wording always survives in status_raw.

import type { BusinessStatus, LicenseStatus } from "./schema.ts";

export function cleanStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// -> "YYYY-MM-DD" or null. Accepts ISO timestamps ("2013-06-27T00:00:00.000") and US "MM/DD/YYYY". The year-1 placeholder
// some portals use for "no date" (0001-01-01) and anything that is not a real calendar date becomes null, never a fake date.
export function isoDate(v: unknown): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s))) { m = +mt[1]; d = +mt[2]; y = +mt[3]; } // US MM/DD/YYYY or MM-DD-YYYY
  else if ((mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else return null;
  if (y < 1700 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// The stored / searched key for a name: upper-case, whitespace collapsed. Ingest and lookup must both use THIS function or
// an exact lookup silently misses.
export function nameKey(v: unknown): string { return (cleanStr(v) || "").toUpperCase(); }

export function joinName(parts: Array<unknown>): string | null {
  const s = parts.map(cleanStr).filter(Boolean).join(" ");
  return s === "" ? null : s;
}

// Free-form person name -> first / last. "Last, First Middle" (comma) or "First [Middle] Last [Suffix]". Returns null when
// there are not at least two name parts (a single token is ambiguous: a business word, or a last name alone).
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "MD", "DO", "RN", "PHD", "ESQ"]);
export function parsePersonName(input: string): { first: string; last: string } | null {
  const raw = (cleanStr(input) || "").replace(/[.]/g, "");
  if (!raw) return null;
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2).map((x) => x.trim());
    const first = (rest || "").split(" ").filter(Boolean)[0];
    return last && first ? { first: first.toUpperCase(), last: last.toUpperCase() } : null;
  }
  const toks = raw.split(" ").filter(Boolean);
  while (toks.length > 2 && SUFFIXES.has(toks[toks.length - 1].toUpperCase())) toks.pop();
  if (toks.length < 2) return null;
  return { first: toks[0].toUpperCase(), last: toks[toks.length - 1].toUpperCase() };
}

// A search term is never placed into SoQL raw. Wildcard characters are removed from prefix terms so a caller cannot turn a
// lookup into a scan; the single quote is doubled by soqlString.
export function stripWildcards(s: string): string { return s.replace(/[%_]/g, " ").replace(/\s+/g, " ").trim(); }

// ------------------------------------------------------------------------------------------------------------------
// BUSINESS status. Buckets: active (in good standing) | delinquent (exists but out of good standing) | inactive (the source
// only says "inactive") | dissolved (existence ended: dissolved / revoked / forfeited / cancelled / expired / withdrawn)
// | merged (merged, consolidated, converted, domesticated) | pending | other (incl. name reservations and rejected filings,
// which are NOT entities -- callers should look at status_raw).
export function normalizeBusinessStatus(raw: string | null): BusinessStatus {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "other";
  if (/reserv|reject|removed/.test(s)) return "other";
  if (/^pending|^active - pending/.test(s)) return "pending";
  if (/merg|consolid|convert|domesticat/.test(s)) return "merged";
  if (/dissol|revok|forfeit|cancel|expired|withdr|renunciat|terminat/.test(s)) return "dissolved";
  if (/delinquent|noncompliant|non-compliant|not in good standing/.test(s)) return "delinquent";
  if (/^(active|good standing|exists|recorded|registered|current)/.test(s)) return "active";
  if (/^inactive/.test(s)) return "inactive";
  return "other";
}

// ------------------------------------------------------------------------------------------------------------------
// LICENSE status. `reason` is an optional second source field (Connecticut publishes INACTIVE + a reason such as "LAPSED DUE
// TO NON-RENEWAL"; that combination is an expiry, not a bare "inactive").
export function normalizeLicenseStatus(raw: string | null, reason?: string | null): LicenseStatus {
  const s = (raw || "").trim().toLowerCase();
  const r = (reason || "").trim().toLowerCase();
  if (!s) return "other";
  if (/revok/.test(s)) return "revoked";
  if (/suspen/.test(s)) return "suspended";
  // Not licenses-in-force and not safely bucketable: a retired-but-practicing status, a refusal, an unresolved approval or
  // qualification, or an APPLICATION that expired (the application lapsed; there was no license). Left as "other" so the
  // caller reads status_raw instead of being told something we are not sure of.
  if (/^retired active|^denied|^need master hire|^approved|^qualified|application/.test(s)) return "other";
  if (/expired|lapsed|not renewed|insurance expired/.test(s)) return "expired";
  if (/^active/.test(s) || /^(licensed|licensed to practice)/.test(s)) return "active";
  if (/^inactive/.test(s) && /lapse|non-?renew|expired|must reapply/.test(r)) return "expired";
  if (/^pending/.test(s)) return "pending";
  if (/^(inactive|retired|closed|cancel|terminat|surrender|voluntary surrender|relinquish|deceased|passed away|out of business|superseded|supercede|transferred|grad to higher|refuse to renew|licensee not renewing|agreed not to renew|beyond|withdrawn|permanent inactive|re-licensed|change of ownership|inoperable|inoperative|non sufficient)/.test(s)) return "inactive";
  return "other";
}
