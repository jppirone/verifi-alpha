// Offline tests for the Virginia DPOR regulant-list parser and the va-dpor adapter rules. With a directory argument it also parses EVERY real downloaded list:
//   node tools/registry/test-dpor.ts [<dir with the downloaded .txt files and labels.json>]
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDporFile, dporPersonName, dporFileInfo } from "../../supabase/functions/_shared/registry/dpor.ts";
import { LICENSE_PROFILES, standingFor, registryLookup, numberVariants, type LicenseRow, type FetchRegistry, type RegistryHit } from "../../supabase/functions/_shared/registry/license-adapter.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";
import { containsEmail } from "../../supabase/functions/_shared/registry/normalize.ts";

assert.deepEqual(dporFileInfo("0401__crnt.txt"), { code: "0401", variant: "current" }); assert.deepEqual(dporFileInfo("0225a_act.txt"), { code: "0225a", variant: "active" });
assert.deepEqual(dporFileInfo("0225o_inact.txt"), { code: "0225o", variant: "inactive" }); assert.deepEqual(dporFileInfo("1301bbi__crnt.txt"), { code: "1301bbi", variant: "current" }); assert.equal(dporFileInfo("readme.txt"), null);
assert.deepEqual(dporPersonName("CHARLES H CHAMBERLAYNE "), { full: "CHARLES H CHAMBERLAYNE", first: "CHARLES", last: "CHAMBERLAYNE" });
assert.deepEqual(dporPersonName("J A FITZGERALD"), { full: "J A FITZGERALD", first: "J", last: "FITZGERALD" }); assert.equal(dporPersonName("JOHN SMITH JR")!.last, "SMITH"); assert.equal(dporPersonName("MADONNA"), null);

const H = "BOARD\tOCCUPATION\tCERTIFICATE #\tINDIVIDUAL NAME\tBUSINESS NAME\tFIRST LINE ADDRESS\tSECOND LINE ADDRESS\tP O BOX #\tCITY\tSTATE\tFIVE DIGIT ZIP CODE\tZIP CODE EXTENSION\tPROVINCE\tCOUNTRY\tPOSTAL CODE\tEXPIRATION DATE\tCERTIFICATION DATE\tLICENSE RANK\tLICENSE SPECIALTY\tEMAILADDRESS";
const row = (o: Record<string, string>) => H.split("\t").map((k) => o[k] ?? "").join("\t");
const txt = [H,
  row({ BOARD: "04", OCCUPATION: "01", "CERTIFICATE #": "001630", "INDIVIDUAL NAME": "CHARLES H CHAMBERLAYNE ", "FIRST LINE ADDRESS": "1102 MAGNOLIA AVENUE", CITY: "NORFOLK", STATE: "VA", "FIVE DIGIT ZIP CODE": "23508", "EXPIRATION DATE": "02/29/2028", "CERTIFICATION DATE": "06/17/1962", "LICENSE RANK": "ARC", EMAILADDRESS: "chamberlaynech@verizon.net" }),
  row({ BOARD: "04", OCCUPATION: "05", "CERTIFICATE #": "000489", "BUSINESS NAME": "GREAT EASTERN RESORT MANAGEMENT INC", "FIRST LINE ADDRESS": "1296 RESORT DR", CITY: "CHARLOTTESVILLE", STATE: "VA", "EXPIRATION DATE": "03/31/2027", "CERTIFICATION DATE": "03/31/2025", EMAILADDRESS: "mwallace@massresort.com" }),
  row({ BOARD: "27", OCCUPATION: "01", "CERTIFICATE #": "2705123456", "INDIVIDUAL NAME": "SAM Q BUILDER JR", "BUSINESS NAME": "BUILDER & SONS LLC", CITY: "RICHMOND", STATE: "VA", "EXPIRATION DATE": "08/31/2027", "LICENSE RANK": "A", "LICENSE SPECIALTY": "BLD" }),
  row({ BOARD: "04", OCCUPATION: "01", "CERTIFICATE #": "", "INDIVIDUAL NAME": "NO NUMBER" }),
].join("\n");
const labels = { "0401": "APELSCIDLA Architect", "0405": "APELSCIDLA Professional Corporation", "2701": "Contractor Class A" };
const { rows, stats } = parseDporFile(txt, "0401__crnt.txt", labels);
assert.equal(stats.rows, 3); assert.equal(stats.rejected, 1); assert.equal(stats.individuals, 2); assert.equal(stats.businesses, 1);
for (const r of rows) assert.deepEqual(licenseProblems(r.record), []);
const arch = rows[0]; assert.equal(arch.record.license_holder_name, "CHARLES H CHAMBERLAYNE"); assert.equal(arch.last_name, "CHAMBERLAYNE"); assert.equal(arch.first_name, "CHARLES"); assert.equal(arch.record.license_type, "APELSCIDLA Architect");
assert.equal(arch.record.status_raw, "Current"); assert.equal(arch.record.expiration_date, "2028-02-29"); assert.equal(arch.record.issue_date, "1962-06-17"); assert.equal(arch.record.state, "VA"); assert.equal(arch.record.details.city, "NORFOLK");
assert.equal(rows[1].record.holder_kind, "business"); assert.equal(rows[1].last_name, null);
const bld = rows[2]; assert.equal(bld.record.details.business_name, "BUILDER & SONS LLC"); assert.equal(bld.record.license_type, "APELSCIDLA Architect (BLD)", "the label comes from the FILE (one occupation per file); the specialty is appended"); assert.equal(bld.last_name, "BUILDER", "suffix JR is not the last name");
// the files carry e-mail and street addresses: none may survive into a stored record
for (const r of rows) { const j = JSON.stringify(r.record); assert.ok(!containsEmail(j) && !/@|MAGNOLIA|RESORT DR|23508/.test(j), "no e-mail, address or zip is kept"); }
const inact = parseDporFile(txt.replace("0401", "0225"), "0225o_inact.txt", labels).rows[0].record; assert.equal(inact.status, "inactive"); assert.equal(inact.status_raw, "Inactive");
assert.equal(parseDporFile(txt, "0225a_act.txt", labels).rows[0].record.status_raw, "Active");

const P = LICENSE_PROFILES["va-dpor"]; assert.ok(P);
const st = (o: Partial<LicenseRow>) => standingFor({ license_holder_name: "A B", license_number: "1", license_type: "Contractor", status: "active", status_raw: "Current", issue_date: null, expiration_date: "2028-01-01", details: {}, ...o } as LicenseRow, P, "2026-10-01");
assert.equal(st({}).standing, "active"); assert.equal(st({ status_raw: "Active" }).standing, "active"); assert.equal(st({ status_raw: "Inactive", status: "inactive" }).standing, "indeterminate", "inactive is held");
assert.equal(st({ expiration_date: "2026-09-01" }).standing, "indeterminate", "past its own expiration"); assert.ok(numberVariants("1630", [P]).includes("001630"), "certificate numbers are zero-padded to 6");

const fx = rows.map((r) => ({ source_id: "va-dpor", record: { ...r.record } as LicenseRow }));
const fetchReg: FetchRegistry = async (b) => { const hits: RegistryHit[] = fx.filter((x) => x.record.license_number === b.license_number); return { ok: true, hits, reports: [{ source_id: "va-dpor", ok: true, count: hits.length }] }; };
const look = (num: string, f: string, l: string) => registryLookup({ state: "VA", licenseNumber: num, firstName: f, lastName: l, today: "2026-10-01" }, fetchReg);
{ const r = await look("1630", "Charles", "Chamberlayne"); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].standing === "active", "bare number found through the padded form"); }
{ const r = await look("001630", "Zed", "Stranger"); assert.ok(r.ok && r.records.length === 0, "shared numbering: a stranger under a real number is dropped"); }

const dir = process.argv[2];
if (dir) {
  const labelsReal = fs.existsSync(`${dir}/labels.json`) ? JSON.parse(fs.readFileSync(`${dir}/labels.json`, "utf8")) : {};
  let files = 0, total = 0, rejected = 0, bad = 0, emailLeaks = 0; const keys = new Set<string>(); const unlabeled = new Set<string>(); const byStatus: Record<string, number> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".txt")).sort()) {
    const t = parseDporFile(fs.readFileSync(`${dir}/${f}`, "latin1"), f, labelsReal); files++; total += t.stats.rows; rejected += t.stats.rejected;
    for (const r of t.rows) { if (licenseProblems(r.record).length) bad++; if (containsEmail(JSON.stringify(r.record))) emailLeaks++; keys.add(r.record_key); byStatus[r.record.status_raw ?? ""] = (byStatus[r.record.status_raw ?? ""] ?? 0) + 1; if (/^Virginia DPOR occupation/.test(r.record.license_type ?? "")) unlabeled.add(`${f}`); }
  }
  assert.equal(bad, 0); assert.equal(emailLeaks, 0);
  console.log(`dpor real files: ${files} files -> ${total} records, ${rejected} rejected, ${keys.size} unique keys, statuses ${JSON.stringify(byStatus)}, ${unlabeled.size} files without a label, 0 schema problems, 0 e-mails kept`);
}
console.log("dpor: file names, names (suffix), parse (no e-mail/address/zip kept), status variants, adapter (current/active pass, inactive + past-expiry held), padded numbers, shared numbering - all passed");
