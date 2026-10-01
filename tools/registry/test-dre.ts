// Offline tests for the California DRE Licensee List parser and the ca-dre adapter rules. With a directory argument it also parses the REAL CurrList.csv:
//   node tools/registry/test-dre.ts [<dir with CurrList.csv>]
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDre, dreStatus } from "../../supabase/functions/_shared/registry/dre.ts";
import { LICENSE_PROFILES, standingFor, registryLookup, numberVariants, type LicenseRow, type FetchRegistry, type RegistryHit } from "../../supabase/functions/_shared/registry/license-adapter.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";

assert.deepEqual(dreStatus("Licensed"), { status: "active", status_raw: "Licensed" }); assert.equal(dreStatus("Licensed NBA").status, "other"); assert.equal(dreStatus("Licensed NBA").status_raw, "Licensed NBA");

const H = "multiple_license_ind,lastname_primary,firstname_secondary,name_suffix,lic_number,lic_type,lic_status,lic_effective_date,lic_expiration_date,original_date_of_license,related_lic_number,related_lastname_primary,related_firstname_secondary,related_name_suffix,related_lic_type,address_1,address_2,city,state,zip_code,foreign_nation,foreign_postal_info,county_name,restricted_flag,ethics_and_agency_ind";
const row = (o: Record<string, string>) => H.split(",").map((k) => o[k] ?? "").map((v) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
const csv = [H,
  row({ multiple_license_ind: "Y", lastname_primary: "White", firstname_secondary: "Terrence Richard", lic_number: "00055592", lic_type: "Broker", lic_status: "Licensed", lic_effective_date: "20260701", lic_expiration_date: "20300701", original_date_of_license: "19900101", address_1: "12 HOME ST", city: "FRESNO", state: "CA", zip_code: "93720", county_name: "FRESNO", restricted_flag: "N" }),
  row({ multiple_license_ind: "Y", lastname_primary: "White", firstname_secondary: "Terrence Richard", lic_number: "00055592", lic_type: "Officer", lic_status: "Licensed", lic_expiration_date: "20281215", related_lic_number: "00054224", related_lastname_primary: "Terich Inc", related_lic_type: "Corporation", city: "FRESNO", state: "CA", county_name: "FRESNO" }),
  row({ lastname_primary: "Terich, Inc", lic_number: "00054224", lic_type: "Corporation", lic_status: "Licensed", lic_expiration_date: "20290101", city: "FRESNO", state: "CA", county_name: "FRESNO", related_lic_number: "00055592", related_lastname_primary: "White", related_firstname_secondary: "Terrence Richard" }),
  row({ lastname_primary: "Khadir", firstname_secondary: "Kian Pasha", name_suffix: "Jr", lic_number: "02229476", lic_type: "Salesperson", lic_status: "Licensed NBA", lic_expiration_date: "20280124", original_date_of_license: "20240125", city: "SAN JOSE", state: "CA", county_name: "SANTA CLARA", restricted_flag: "N" }),
  row({ lastname_primary: "Rest", firstname_secondary: "Ricky", lic_number: "01111111", lic_type: "Salesperson", lic_status: "Licensed", lic_expiration_date: "20290101", city: "ORANGE", state: "CA", county_name: "ORANGE", restricted_flag: "Y" }),
  row({ lastname_primary: "", firstname_secondary: "Bad", lic_number: "09999999", lic_type: "Salesperson", lic_status: "Licensed" }),
].join("\n");
const { rows, stats } = parseDre(csv);
assert.equal(stats.rows, 5); assert.equal(stats.rejected, 1); assert.equal(stats.businesses, 1); assert.equal(stats.individuals, 4);
for (const r of rows) assert.deepEqual(licenseProblems(r.record), []);
assert.equal(new Set(rows.map((r) => r.record_key)).size, rows.length, "a broker who is also an officer has two rows with distinct keys");
const white = rows.filter((r) => r.record.license_number === "00055592"); assert.equal(white.length, 2); assert.equal(white[0].record.license_holder_name, "Terrence Richard White"); assert.equal(white[0].last_name, "White"); assert.equal(white[0].first_name, "Terrence Richard");
assert.equal(white[0].record.license_type, "Real Estate Broker"); assert.equal(white[0].record.expiration_date, "2030-07-01"); assert.equal(white[0].record.issue_date, "1990-01-01");
const kk = rows.find((r) => r.record.license_number === "02229476")!.record; assert.equal(kk.license_holder_name, "Kian Pasha Khadir Jr"); assert.equal(kk.status_raw, "Licensed NBA");
const corp = rows.find((r) => r.record.license_number === "00054224")!.record; assert.equal(corp.holder_kind, "business"); assert.equal(corp.license_holder_name, "Terich, Inc"); assert.equal(rows.find((r) => r.record.license_number === "00054224")!.last_name, null);
for (const r of rows) { const j = JSON.stringify(r.record); assert.ok(!/HOME ST|93720|Terich/.test(j.replace(/"license_holder_name":"[^"]*"/, "")), "no street address, zip or related person name kept"); assert.ok(!("address_1" in r.record.details)); }

const P = LICENSE_PROFILES["ca-dre"]; assert.ok(P);
const st = (o: Partial<LicenseRow>) => standingFor({ license_holder_name: "A B", license_number: "1", license_type: "Real Estate Broker", status: "active", status_raw: "Licensed", issue_date: null, expiration_date: "2029-01-01", details: {}, ...o } as LicenseRow, P, "2026-10-01");
assert.equal(st({}).standing, "active"); assert.equal(st({ status_raw: "Licensed NBA" }).standing, "indeterminate", "licensed but no broker association"); assert.equal(st({ details: { restricted: true } }).standing, "indeterminate");
assert.match(st({ details: { restricted: true } }).note ?? "", /restricted/); assert.equal(st({ expiration_date: "2026-09-01" }).standing, "indeterminate", "past its own expiration");
assert.ok(numberVariants("55592", [P]).includes("00055592"), "DRE numbers are zero-padded to 8");

const toRow = (r: ReturnType<typeof parseDre>["rows"][number]): LicenseRow => ({ ...r.record } as LicenseRow);
const fx = rows.map((r) => ({ source_id: "ca-dre", record: toRow(r) }));
const fetchReg: FetchRegistry = async (b) => { const hits: RegistryHit[] = fx.filter((x) => x.record.license_number === b.license_number); return { ok: true, hits, reports: [{ source_id: "ca-dre", ok: true, count: hits.length }] }; };
const look = (num: string, f: string, l: string) => registryLookup({ state: "CA", licenseNumber: num, firstName: f, lastName: l, today: "2026-10-01" }, fetchReg);
{ const r = await look("55592", "Terrence", "White"); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].standing === "active", "broker + officer rows collapse into ONE active license; bare number found through the padded form"); }
{ const r = await look("02229476", "Kian", "Khadir"); assert.ok(r.ok && r.records[0].nameMatches && r.records[0].standing === "indeterminate", "NBA is held"); }
{ const r = await look("01111111", "Ricky", "Rest"); assert.ok(r.ok && r.records[0].standing === "indeterminate", "restricted is held"); }
{ const r = await look("55592", "Zed", "Stranger"); assert.ok(r.ok && r.records.length === 0, "a stranger under a real number is dropped (shared California numbering)"); }

const dir = process.argv[2];
if (dir) {
  const t = parseDre(fs.readFileSync(`${dir}/CurrList.csv`, "latin1"));
  assert.equal(t.stats.rows + t.stats.rejected, 428271);
  let bad = 0; for (const r of t.rows) if (licenseProblems(r.record).length) bad++; assert.equal(bad, 0); assert.equal(new Set(t.rows.map((r) => r.record_key)).size, t.rows.length);
  console.log(`dre real file: ${t.stats.rows} records (${t.stats.individuals} individuals, ${t.stats.businesses} corporations), ${t.stats.rejected} rejected, 0 schema problems, unique keys`);
}
console.log("dre: parse (no address/zip/related person kept), status, adapter (Licensed passes; NBA, restricted, past-expiry held), zero-padded numbers, collapse, shared numbering - all passed");
