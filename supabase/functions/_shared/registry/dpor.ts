// Virginia Department of Professional and Occupational Regulation (DPOR) "Regulant Lists" -> registry records (2026-10-01).
// Source: https://www.dpor.virginia.gov/RegulantLists, the Board's own free downloads: ~180 ASCII tab-delimited files, one per occupation (architect, professional
// engineer, real estate broker/salesperson, contractor classes, cosmetologist, barber, home inspector, auctioneer, ...), "provided free of charge", updated about every
// 5 business days, phone numbers not included. Health professions (nurses, physicians) are NOT here: Virginia's Department of Health Professions sells its data.
// File names: <code>__crnt.txt (everyone currently licensed), <code>_act.txt / <code>_inact.txt (real estate lists split by active / inactive), and
// <code>_act__crnt.txt / <code>_inact__crnt.txt (an active / inactive split of a current list).
// Columns: BOARD, OCCUPATION, CERTIFICATE #, INDIVIDUAL NAME ("FIRST [M] LAST", no delimiter), BUSINESS NAME, address lines, CITY, STATE, ZIP..., EXPIRATION DATE,
// CERTIFICATION DATE, LICENSE RANK, LICENSE SPECIALTY, EMAILADDRESS.
// NOT kept: every address line, zip, P O box, country / postal code, and the E-MAIL ADDRESS (the files carry real ones; they are never stored). Kept: city and state.

import type { LicenseRecord, HolderKind } from "./schema.ts";
import { cleanStr, isoDate, placeOrNull } from "./normalize.ts";
import type { IngestLicense } from "./ca-dca.ts";

export interface DporStats { files: number; rows: number; individuals: number; businesses: number; rejected: number; rejectedSamples: Array<{ file: string; line: number; reason: string }>; placeBlanked: number }

const SUFFIX = new Set(["JR", "SR", "II", "III", "IV", "V"]);
// "CHARLES H CHAMBERLAYNE " / "J A FITZGERALD" / "JOHN SMITH JR": first token is the first name, the last non-suffix token the last name.
export function dporPersonName(raw: string): { full: string; first: string; last: string } | null {
  const toks = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (toks.length < 2) return null;
  let end = toks.length; while (end > 2 && SUFFIX.has(toks[end - 1].replace(/\./g, "").toUpperCase())) end--;
  return { full: toks.join(" "), first: toks[0], last: toks[end - 1] };
}

export function dporFileInfo(fileName: string): { code: string; variant: "current" | "active" | "inactive" } | null {
  // 0401__crnt.txt (current) | 0225a_act.txt / 0225a_inact.txt (real estate) | 4001c_act__crnt.txt / 4001c_inact__crnt.txt (an active / inactive split of a current list)
  const m = /^(\d{4}[a-z]*?)(?:_(act|inact))?(?:__crnt)?\.txt$/i.exec(fileName.trim());
  if (!m || (!m[2] && !/__crnt\.txt$/i.test(fileName))) return null;
  return { code: m[1].toLowerCase(), variant: m[2] ? (m[2].toLowerCase() === "act" ? "active" : "inactive") : "current" };
}

// Three lists the page names in a heading rather than as list items.
const FALLBACK_LABELS: Record<string, string> = { "2710": "Tradesman (Combined License)", "2801cpg": "Certified Professional Geologist", "2801lpg": "Licensed Professional Geologist" };

export function parseDporFile(text: string, fileName: string, labels: Record<string, string>): { rows: IngestLicense[]; stats: DporStats } {
  const stats: DporStats = { files: 1, rows: 0, individuals: 0, businesses: 0, rejected: 0, rejectedSamples: [], placeBlanked: 0 };
  const out: IngestLicense[] = [];
  const info = dporFileInfo(fileName); if (!info) throw new Error(`DPOR: unrecognised file name ${fileName}`);
  const lines = text.split(/\r?\n/); while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = (lines[0] ?? "").split("\t").map((h) => h.trim());
  const ix = (n: string) => { const i = header.indexOf(n); if (i < 0) throw new Error(`DPOR ${fileName}: column ${n} missing`); return i; };
  const c = { board: ix("BOARD"), occ: ix("OCCUPATION"), no: ix("CERTIFICATE #"), person: ix("INDIVIDUAL NAME"), biz: ix("BUSINESS NAME"), city: ix("CITY"), state: ix("STATE"),
    exp: ix("EXPIRATION DATE"), cert: ix("CERTIFICATION DATE"), rank: ix("LICENSE RANK"), spec: ix("LICENSE SPECIALTY") };
  const status: { status: LicenseRecord["status"]; status_raw: string } = info.variant === "inactive" ? { status: "inactive", status_raw: "Inactive" } : info.variant === "active" ? { status: "active", status_raw: "Active" } : { status: "active", status_raw: "Current" };
  const source = "dpor.virginia.gov/RegulantLists (free public regulant lists)";
  const board = "Virginia Department of Professional and Occupational Regulation";
  for (let n = 1; n < lines.length; n++) {
    const r = lines[n].split("\t");
    if (r.length < header.length - 1) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ file: fileName, line: n + 1, reason: `${r.length} fields, expected ${header.length}` }); continue; }
    const no = cleanStr(r[c.no]); const code = `${cleanStr(r[c.board]) ?? ""}${cleanStr(r[c.occ]) ?? ""}`;
    const personRaw = cleanStr(r[c.person]); const bizRaw = cleanStr(r[c.biz]);
    if (!no || (!personRaw && !bizRaw)) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ file: fileName, line: n + 1, reason: "no certificate number or name" }); continue; }
    const person = personRaw ? dporPersonName(personRaw) : null;
    if (personRaw && !person) { stats.rejected++; continue; }
    const city = placeOrNull(r[c.city]); if (cleanStr(r[c.city]) && !city) stats.placeBlanked++;
    const stem = fileName.replace(/\.txt$/i, "");
    const label = labels[stem] ?? labels[info.code] ?? FALLBACK_LABELS[info.code] ?? labels[code] ?? `Virginia DPOR occupation ${info.code}`;
    const rank = cleanStr(r[c.rank]), spec = cleanStr(r[c.spec]);
    const record: LicenseRecord = {
      license_holder_name: person ? person.full : bizRaw!, holder_kind: (person ? "individual" : "business") as HolderKind, license_number: no,
      license_type: spec ? `${label} (${spec})` : label, status: status.status, status_raw: status.status_raw, issue_date: isoDate(r[c.cert]), expiration_date: isoDate(r[c.exp]),
      state: "VA", board_agency: board, source,
      details: { dpor_code: info.code, rank, specialty: spec, city, holder_state: cleanStr(r[c.state]), ...(person && bizRaw ? { business_name: bizRaw } : {}) },
    };
    out.push({ record_key: `${info.code}|${no}|${info.variant}|${person ? "p" : "b"}`, last_name: person ? person.last : null, first_name: person ? person.first : null, record });
    stats.rows++; if (person) stats.individuals++; else stats.businesses++;
  }
  return { rows: out, stats };
}
