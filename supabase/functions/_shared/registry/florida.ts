// Florida Division of Corporations (Sunbiz) bulk "Corporate Data File" -> normalized BusinessEntity.
//
// The source is NOT Socrata and NOT an API: Florida publishes fixed-width ASCII flat files (quarterly full + daily) on the
// Department of State's public SFTP (see https://dos.fl.gov/sunbiz/other-services/data-downloads/ and the field guide at
// .../corporate-file-definitions). The live Sunbiz search site is behind Cloudflare and is deliberately NOT scraped.
//
// Layout (record length 1440, from the published "Corporate File Definitions"; 1-based positions below):
//    1  Corporation Number   1-12     2 Corporation Name  13-204   3 Status 205 (A active / I inactive)   4 Filing Type 206-220
//    5  Address 1  221-262 | 6 Address 2 263-304 | 7 City 305-332 | 8 State 333-334 | 9 Zip 335-344 | 10 Country 345-346
//   11-16 Mailing address  347-472 | 17 File Date 473-480 | 18 FEI 481-494 | 19 >6 officers flag 495 | 20 Last Transaction Date 496-503
//   31 Registered Agent Name 545-586 | 32 RA type 587 | 33-36 RA address 588-668
//   37-77 six officer blocks of 128 chars starting at 669: title(4) type(1) name(42) address(42) city(28) state(2) zip(9)
//
// Date format caveat: the guide says only "8 characters". Sunbiz files are commonly MMDDYYYY while the guide's neighbours use
// YYYYMMDD; parseFlDate() accepts either (unambiguous: a YYYYMMDD value's first four digits are >= 1700, which can never be a
// valid MMDD), and returns null -- never a guess -- for anything else. Verified only against the published layout and a
// synthetic record built from it, NOT against a real downloaded record (the SFTP login was not exercised; see the report).

import type { BusinessEntity } from "./schema.ts";
import { cleanStr, isoDate, normalizeBusinessStatus } from "./normalize.ts";

export const FL_RECORD_LENGTH = 1440;
export const FL_SOURCE_DATASET = "dos.fl.gov/sunbiz bulk data: Corporate Data File (fixed-width)";

const f = (line: string, start: number, len: number) => cleanStr(line.substr(start - 1, len));

export const FL_FILING_TYPES: Record<string, string> = {
  DOMP: "Domestic Profit Corporation", DOMNP: "Domestic Non-Profit Corporation", FORP: "Foreign Profit Corporation",
  FORNP: "Foreign Non-Profit Corporation", DOMLP: "Domestic Limited Partnership", FORLP: "Foreign Limited Partnership",
  FLAL: "Florida Limited Liability Company", FORL: "Foreign Limited Liability Company", NPREG: "Non-Profit Registration",
  TRUST: "Declaration of Trust", AGENT: "Designation of Registered Agent",
};

export function parseFlDate(v: string | null): string | null {
  if (!v || !/^\d{8}$/.test(v)) return null;
  const y = +v.slice(0, 4);
  if (y >= 1700) return isoDate(v); // YYYYMMDD
  return isoDate(`${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4, 8)}`); // MMDDYYYY
}

export interface FlParseStats { lines: number; parsed: number; rejected: number; rejectedSamples: Array<{ line: number; reason: string }> }

export function parseFlCorporateLine(line: string): BusinessEntity | { error: string } {
  if (line.length < 669) return { error: `record too short (${line.length} chars; layout is ${FL_RECORD_LENGTH})` };
  const id = f(line, 1, 12), name = f(line, 13, 192);
  if (!id || !name) return { error: "no corporation number or name" };
  const statusCode = f(line, 205, 1);
  const status_raw = statusCode === "A" ? "Active" : statusCode === "I" ? "Inactive" : statusCode;
  const filing = f(line, 206, 15);
  const officers: Array<Record<string, string | null>> = [];
  for (let i = 0; i < 6; i++) {
    const o = 669 + i * 128;
    const oname = f(line, o + 5, 42);
    if (oname) officers.push({ name: oname, title: f(line, o, 4), kind: f(line, o + 4, 1) === "C" ? "corporation" : "person" });
  }
  const ra = f(line, 545, 42);
  return {
    entity_name: name, entity_id: id,
    status: statusCode === "A" ? "active" : statusCode === "I" ? "inactive" : normalizeBusinessStatus(status_raw),
    status_raw,
    registration_date: parseFlDate(f(line, 473, 8)),
    entity_type: filing ? (FL_FILING_TYPES[filing] ?? filing) : null,
    state: "FL", source_dataset: FL_SOURCE_DATASET,
    details: {
      filing_type_code: filing, principal_city: f(line, 305, 28), principal_state: f(line, 333, 2), jurisdiction_state_country: f(line, 504, 2),
      last_transaction_date: parseFlDate(f(line, 496, 8)), fei_number: f(line, 481, 14),
      ...(ra ? { registered_agent: ra } : {}),
      ...(officers.length ? { officers, more_than_six_officers: f(line, 495, 1) === "Y" } : {}),
    },
  };
}

export function parseFlCorporateFile(text: string): { rows: BusinessEntity[]; stats: FlParseStats } {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const stats: FlParseStats = { lines: lines.length, parsed: 0, rejected: 0, rejectedSamples: [] };
  const rows: BusinessEntity[] = [];
  lines.forEach((l, i) => {
    const r = parseFlCorporateLine(l);
    if ("error" in r) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: i + 1, reason: r.error }); }
    else { rows.push(r); stats.parsed++; }
  });
  return { rows, stats };
}
