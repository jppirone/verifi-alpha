// Michigan LARA (Bureau of Professional Licensing) license lists -> normalized LicenseRecord (2026-09-30).
//
// What the source really is (NOT "FOIA request-based" as the brief assumed): michigan.gov/lara/bureau-list/bpl/license-lists-and-reports
// links seven "FOIA" report lists that are generated live by the MiPLUS (Accela) portal and download as .xlsx with no request,
// form, fee or login (anonymous session only). ~799k rows across 7 files (A-L, M-O, P-V, Real Estate, Cosmetology, Nursing, Pharmacy).
// They list ACTIVE-ish licenses only (Active, Active - In Late Renewal, Suspended, Disciplinary Limited, Voluntary Limited, Limited):
// no expired / revoked / lapsed rows, so "not on the list" cannot tell expired from never licensed.
//
// PRIVACY: every file carries home street addresses and personal email addresses. They are NOT read into our records: only
// city, county and state survive. (Whether the lists may be redistributed or contacted from is a legal question for the owner.)
//
// Input here is TAB-DELIMITED TEXT produced from the xlsx by tools/registry/xlsx-to-tsv.py (dates already ISO). Parsing is
// header-driven like the California parser.

import type { LicenseRecord } from "./schema.ts";
import { cleanStr, isoDate, joinName, normalizeLicenseStatus } from "./normalize.ts";
import type { IngestLicense, ParseStats } from "./ca-dca.ts";

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
export const MI_SOURCE = "michigan.gov/lara BPL license lists (MiPLUS FOIA reports)";

function miStatus(raw: string | null): LicenseRecord["status"] {
  const s = (raw || "").trim().toLowerCase();
  if (/^active/.test(s)) return "active"; // "Active" and "Active - In Late Renewal" (still licensed; the late-renewal wording stays in status_raw)
  if (/suspen/.test(s)) return "suspended";
  return normalizeLicenseStatus(raw); // Limited / Disciplinary Limited / Voluntary Limited -> "other": status_raw carries the truth
}

export function parseMichiganTsv(text: string, opts: { sourceLabel?: string } = {}): { rows: IngestLicense[]; stats: ParseStats; header: string[] } {
  const source = opts.sourceLabel ?? MI_SOURCE;
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = (lines[0] ?? "").split("\t");
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[norm(h)] = i; });
  const stats: ParseStats = { lines: Math.max(lines.length - 1, 0), parsed: 0, rejected: 0, rejectedSamples: [] };
  const need = ["lastname", "firstname", "facilityname", "profession", "type", "licenseno", "status", "issuedate", "expiration"];
  const missing = need.filter((k) => !(k in idx));
  if (missing.length) return { rows: [], stats: { ...stats, rejected: stats.lines, rejectedSamples: [{ line: 1, reason: `header missing columns: ${missing.join(", ")}` }] }, header };
  const out: IngestLicense[] = [];
  const reject = (line: number, reason: string) => { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line, reason }); };
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split("\t");
    if (cols.length !== header.length) { reject(li + 1, `expected ${header.length} columns, got ${cols.length}`); continue; }
    const g = (k: string) => (k in idx ? cleanStr(cols[idx[k]]) : null);
    const last = g("lastname"), first = g("firstname"), facility = g("facilityname");
    const individual = !!(last || first);
    const name = individual ? joinName([first, g("middlename"), last, g("suffix")]) : facility;
    const number = g("licenseno");
    if (!name || !number) { reject(li + 1, "no holder name or no license number"); continue; }
    const status_raw = g("status");
    const profession = g("profession");
    const record: LicenseRecord = {
      license_holder_name: name, holder_kind: individual ? "individual" : "business", license_number: number,
      license_type: g("type"), status: miStatus(status_raw), status_raw,
      issue_date: isoDate(g("issuedate")), expiration_date: isoDate(g("expiration")),
      state: "MI", board_agency: "Michigan Department of Licensing and Regulatory Affairs (LARA), Bureau of Professional Licensing", source,
      details: {
        profession, ...(g("specialities") ? { specialities: g("specialities") } : {}),
        // facility a person is licensed at is not carried; only the holder's own location (city / county / state), never street address or email
        city: g("addrcity"), county: g("county"), holder_state: g("state"),
      },
    };
    out.push({ record_key: `${profession ?? ""}|${number}`, last_name: individual ? last : null, first_name: individual ? first : null, record });
    stats.parsed++;
  }
  return { rows: out, stats, header };
}
