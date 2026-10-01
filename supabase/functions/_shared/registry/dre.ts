// California Department of Real Estate (DRE) "Licensee List" -> registry records (2026-10-01).
// Source: https://secure.dre.ca.gov/datafile/CurrList.zip (CurrList.csv), published free by the DRE on its "Examinee List/Licensee List Data Files" page and
// refreshed daily; field definitions are the DRE's Form RE 776. (The restriction on the file page, Civil Code s.1798.61(b), applies to the EXAMINEE list, not this one.)
// Measured 2026-10-01: 428,271 rows, 405,566 distinct license numbers (a broker who is also an officer of a corporation has one row per role), types Salesperson /
// Broker / Officer / Corporation, status Licensed (340,667) or Licensed NBA (87,604: licensed but with no broker association, so not able to act), 2,263 restricted
// licenses. It lists CURRENT licensees only: expired, revoked and surrendered licenses are not in it.
// NOT kept: address, zip, foreign postal info, the related person's name. Kept: city, county, state, the license's type/number/status/dates, the restricted flag.

import type { LicenseRecord, HolderKind } from "./schema.ts";
import { cleanStr, isoDate, placeOrNull } from "./normalize.ts";
import { parseCsv } from "./cslb.ts";
import type { IngestLicense } from "./ca-dca.ts";

export interface DreStats { rows: number; individuals: number; businesses: number; rejected: number; rejectedSamples: Array<{ line: number; reason: string }>; placeBlanked: number }

const TYPE_NAME: Record<string, string> = {
  Salesperson: "Real Estate Salesperson", Broker: "Real Estate Broker", Officer: "Real Estate Broker (Corporation Officer)", Corporation: "Corporate Real Estate Broker",
};
export function dreStatus(raw: string): { status: LicenseRecord["status"]; status_raw: string } {
  const s = raw.trim();
  if (s.toLowerCase() === "licensed") return { status: "active", status_raw: s };
  return { status: "other", status_raw: s || "(none)" }; // "Licensed NBA" and anything new: status_raw carries the truth
}

export function parseDre(csv: string): { rows: IngestLicense[]; stats: DreStats } {
  const stats: DreStats = { rows: 0, individuals: 0, businesses: 0, rejected: 0, rejectedSamples: [], placeBlanked: 0 };
  const out: IngestLicense[] = [];
  const M = parseCsv(csv); const h = M[0] ?? [];
  const ix = (n: string) => { const i = h.indexOf(n); if (i < 0) throw new Error(`DRE: column ${n} missing`); return i; };
  const c = { last: ix("lastname_primary"), first: ix("firstname_secondary"), suffix: ix("name_suffix"), no: ix("lic_number"), type: ix("lic_type"), st: ix("lic_status"),
    eff: ix("lic_effective_date"), exp: ix("lic_expiration_date"), orig: ix("original_date_of_license"), rel: ix("related_lic_number"), reltype: ix("related_lic_type"),
    city: ix("city"), state: ix("state"), county: ix("county_name"), restricted: ix("restricted_flag"), multi: ix("multiple_license_ind") };
  const source = "dre.ca.gov/Licensees/ExamineeLicenseeListDataFiles (Licensee List, CurrList.csv)";
  for (let n = 1; n < M.length; n++) {
    const r = M[n];
    if (r.length !== h.length) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: n + 1, reason: `${r.length} fields, expected ${h.length}` }); continue; }
    const no = cleanStr(r[c.no]); const lastRaw = cleanStr(r[c.last]); const type = cleanStr(r[c.type]);
    if (!no || !lastRaw || !type) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: n + 1, reason: "no license number, name or type" }); continue; }
    const isBiz = type === "Corporation";
    const first = cleanStr(r[c.first]); const suffix = cleanStr(r[c.suffix]);
    if (!isBiz && !first) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: n + 1, reason: "individual with no first name" }); continue; }
    const st = dreStatus(r[c.st]);
    const city = placeOrNull(r[c.city]), county = placeOrNull(r[c.county]);
    if ((cleanStr(r[c.city]) && !city) || (cleanStr(r[c.county]) && !county)) stats.placeBlanked++;
    const name = isBiz ? lastRaw : [first, lastRaw, suffix].filter(Boolean).join(" ");
    const record: LicenseRecord = {
      license_holder_name: name, holder_kind: (isBiz ? "business" : "individual") as HolderKind, license_number: no, license_type: TYPE_NAME[type] ?? type,
      status: st.status, status_raw: st.status_raw, issue_date: isoDate(r[c.orig]), expiration_date: isoDate(r[c.exp]),
      state: "CA", board_agency: "California Department of Real Estate", source,
      details: { dre_type: type, city, county, holder_state: cleanStr(r[c.state]), restricted: cleanStr(r[c.restricted]) === "Y", multiple_licenses: cleanStr(r[c.multi]) === "Y", related_type: cleanStr(r[c.reltype]), effective_date: isoDate(r[c.eff]) },
    };
    out.push({ record_key: `${no}|${type}|${cleanStr(r[c.rel]) ?? ""}`, last_name: isBiz ? null : lastRaw, first_name: isBiz ? null : first, record });
    stats.rows++; if (isBiz) stats.businesses++; else stats.individuals++;
  }
  return { rows: out, stats };
}
