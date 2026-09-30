// California Department of Consumer Affairs (DCA) licensee lists -> normalized LicenseRecord (2026-09-30).
//
// What the source really is (verified 2026-09-30 by downloading the files, NOT what the brief assumed): monthly snapshots
// published as files in a public Box shared folder linked from https://www.dca.ca.gov/consumers/public_info/index.html
// ("Licensee Lists"); 33 board folders; "<Board>_Data00.xls" files that are actually TAB-DELIMITED TEXT (two boards, Dental and
// Court Reporters, are real .xlsx); no CSV of licensee data. The DCA Search API exists but is gated behind a request form.
// Five column layouts exist across boards (some with an Agency Code, some without, renamed columns in Dental, a typo'd
// "Original Isuue Date" in Court Reporters), so parsing is HEADER-DRIVEN: columns are found by normalized name, never by
// position. License numbers are unique only within a license type, so the record key is agency + type + number.
//
// Status: Current / Active -> active; Delinquent (renewal overdue, lapsed) -> expired; CurrentInactive / Inactive -> inactive;
// Expired -> expired; Suspension -> suspended. The source's own word is always kept in status_raw. NOTE: no revoked / surrendered /
// cancelled status appears in any file (the page lists only Current, Delinquent and Inactive) -- "revoked" cannot be told from
// these lists; disciplinary status is only on DCA's gated search.

import type { LicenseRecord } from "./schema.ts";
import { cleanStr, isoDate, joinName, normalizeLicenseStatus } from "./normalize.ts";

export interface IngestLicense { record_key: string; last_name: string | null; first_name: string | null; record: LicenseRecord }
export interface ParseStats { lines: number; parsed: number; rejected: number; rejectedSamples: Array<{ line: number; reason: string }> }

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES: Record<string, string> = {
  licensetypename: "licensetype", originalisuuedate: "originalissuedate", zipcode: "zip",
  addressline1: "address1", addressline2: "address2", licensetypecode: "lictypecode",
};
const canon = (h: string) => { const n = norm(h); return ALIASES[n] ?? n; };

function caStatus(raw: string | null): ReturnType<typeof normalizeLicenseStatus> {
  const s = (raw || "").trim().toLowerCase();
  if (s === "current" || s === "active") return "active";
  if (s === "delinquent") return "expired";
  if (s === "currentinactive" || s === "inactive") return "inactive";
  if (s === "suspension" || s === "suspended") return "suspended";
  return normalizeLicenseStatus(raw);
}

export function parseCaDcaTsv(text: string, opts: { sourceLabel?: string } = {}): { rows: IngestLicense[]; stats: ParseStats; header: string[] } {
  const source = opts.sourceLabel ?? "dca.ca.gov/consumers/public_info (monthly licensee lists)";
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = (lines[0] ?? "").split("\t");
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[canon(h)] = i; });
  const need = ["agencyname", "licensetype", "licensenumber", "indivorg", "orglastname", "licensestatus"];
  const missing = need.filter((k) => !(k in idx));
  const stats: ParseStats = { lines: Math.max(lines.length - 1, 0), parsed: 0, rejected: 0, rejectedSamples: [] };
  if (missing.length) return { rows: [], stats: { ...stats, rejected: stats.lines, rejectedSamples: [{ line: 1, reason: `header missing columns: ${missing.join(", ")}` }] }, header };
  const out: IngestLicense[] = [];
  const reject = (line: number, reason: string) => { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line, reason }); };
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split("\t");
    // Files occasionally contain a row that does not line up (a stray quote / line break in an address). Never guess at those.
    if (cols.length !== header.length) { reject(li + 1, `expected ${header.length} columns, got ${cols.length}`); continue; }
    const g = (k: string) => (k in idx ? cleanStr(cols[idx[k]]) : null);
    const kind = (g("indivorg") || "").toUpperCase();
    const isOrg = kind === "O";
    const last = g("orglastname"), first = g("firstname");
    const name = isOrg ? last : joinName([first, g("middlename"), last, g("suffix")]);
    const number = g("licensenumber");
    if (!name || !number) { reject(li + 1, "no holder name or no license number"); continue; }
    const agency = g("agencyname")!;
    const typeCode = g("lictypecode") ?? g("specialitycode") ?? g("licensetype") ?? "";
    const status_raw = g("licensestatus");
    const record: LicenseRecord = {
      license_holder_name: name,
      holder_kind: isOrg ? "business" : kind === "I" ? "individual" : "unknown",
      license_number: number,
      license_type: g("licensetype"),
      status: caStatus(status_raw), status_raw,
      issue_date: isoDate(g("originalissuedate")), expiration_date: isoDate(g("expirationdate")),
      state: "CA", board_agency: agency, source,
      details: {
        agency_code: g("agencycode"), license_type_code: g("lictypecode") ?? g("specialitycode"),
        city: g("city"), county: g("county"), holder_state: g("state"),
        ...(g("degree") ? { degree: g("degree") } : {}), ...(g("school") ? { school: g("school") } : {}),
        ...(g("yeargraduated") ? { year_graduated: g("yeargraduated") } : {}), ...(g("statuseffectivedate") ? { status_effective_date: isoDate(g("statuseffectivedate")) } : {}),
      },
    };
    out.push({ record_key: `${g("agencycode") ?? agency}|${typeCode}|${number}`, last_name: isOrg ? null : last, first_name: isOrg ? null : first, record });
    stats.parsed++;
  }
  return { rows: out, stats, header };
}
