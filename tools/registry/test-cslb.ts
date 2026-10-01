// Offline tests for the CSLB parser (supabase/functions/_shared/registry/cslb.ts) on a synthetic fixture shaped exactly like the Board's real files, plus the
// adapter rules for the ca-cslb source. With a directory argument it also parses the REAL downloaded files and checks the measured totals:
//   node tools/registry/test-cslb.ts [<dir with license_master.csv + personnel.csv>]
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCsv, parseCslb, cslbStatus, cslbClassNames, cslbPersonName, currentTitles } from "../../supabase/functions/_shared/registry/cslb.ts";
import { LICENSE_PROFILES, standingFor, registryLookup, type LicenseRow, type FetchRegistry, type RegistryHit } from "../../supabase/functions/_shared/registry/license-adapter.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";

// ---- CSV
assert.deepEqual(parseCsv('a,b,c\n1,"x, y",3\n"q ""z""",2,\n'), [["a", "b", "c"], ["1", "x, y", "3"], ['q "z"', "2", ""]]);
assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]); assert.deepEqual(parseCsv('a\n"line1\nline2"\n'), [["a"], ["line1\nline2"]], "newline inside quotes");

// ---- status: only a bare CLEAR is clean
assert.deepEqual(cslbStatus("CLEAR", "", "", ""), { status: "active", status_raw: "CLEAR" });
assert.deepEqual(cslbStatus("CLEAR", "WC Susp Pending", "", ""), { status: "active", status_raw: "CLEAR; WC Susp Pending" });
assert.deepEqual(cslbStatus("Contr Bond Susp", "", "", ""), { status: "suspended", status_raw: "Contr Bond Susp" });
assert.equal(cslbStatus("CLEAR", "", "01/01/2020", "").status, "inactive", "inactivated and never reactivated"); assert.equal(cslbStatus("CLEAR", "", "01/01/2020", "02/02/2021").status, "active");
assert.equal(cslbStatus("Something New", "", "", "").status, "other");

// ---- classes / names / personnel association
assert.equal(cslbClassNames("B"), "General Building Contractor (B)"); assert.equal(cslbClassNames("C10| C-33"), "Electrical (C10); Painting and Decorating (C33)"); assert.equal(cslbClassNames("D28"), "Limited Specialty (D28)"); assert.equal(cslbClassNames(""), null);
assert.deepEqual(cslbPersonName(" NILSEN                             MARK           ALAN"), { last: "NILSEN", first: "MARK", middle: "ALAN" });
assert.deepEqual(cslbPersonName(" DI GIORGIO                         DAVID          LOUIS"), { last: "DI GIORGIO", first: "DAVID", middle: "LOUIS" }); assert.equal(cslbPersonName(" DE MARSE"), null, "one token is never a person");
assert.deepEqual(currentTitles(" Officer", " "), ["Officer"]); assert.deepEqual(currentTitles(" Qualifying Partner| Qualifying Partner", " | "), ["Qualifying Partner", "Qualifying Partner"]);
assert.equal(currentTitles(" Responsible Managing Officer| Responsible Managing Officer|", " 10/28/2003| 10/28/2003| 06/21/2006| 01/01/2004| 06/30/2006|"), null, "every association ended: historical");
assert.deepEqual(currentTitles(" Responsible Managing Member| Responsible Managing Manager", " 12/31/2025| "), ["Responsible Managing Manager"], "only the open association counts");

// ---- parse a fixture
const MH = "LicenseNo,LastUpdate,BusinessName,BUS-NAME-2,FullBusinessName,MailingAddress,City,State,County,ZIPCode,country,BusinessPhone,BusinessType,IssueDate,ReissueDate,ExpirationDate,InactivationDate,ReactivationDate,PendingSuspension,PendingClassRemoval,PendingClassReplace,PrimaryStatus,SecondaryStatus,Classifications(s),DiscpCaseRegion,DBCaseNo";
const mrow = (o: Record<string, string>) => MH.split(",").map((h) => o[h] ?? "").map((v) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
const master = [MH,
  mrow({ LicenseNo: "1000002", BusinessName: "DOCKERY RANDALL MARK", FullBusinessName: "RANDALL MARK DOCKERY", MailingAddress: "301 SOUTH MILLS AVENUE", City: "LODI", State: "CA", County: "San Joaquin", BusinessPhone: "(925) 383 0487", BusinessType: "Sole Owner", IssueDate: "01/10/2015", ExpirationDate: "01/31/2027", PrimaryStatus: "CLEAR", "Classifications(s)": "C57", LastUpdate: "09/25/2026" }),
  mrow({ LicenseNo: "632600", BusinessName: "SAFE-T-WALK INC", City: "OAKLAND", County: "Alameda", BusinessType: "Corporation", ExpirationDate: "06/30/2027", PrimaryStatus: "CLEAR", "Classifications(s)": "B" }),
  mrow({ LicenseNo: "700001", BusinessName: "ACME, \"QUALITY\" ROOFING INC", City: "FRESNO", County: "Fresno", BusinessType: "Corporation", ExpirationDate: "03/31/2027", PrimaryStatus: "Contr Bond Susp", SecondaryStatus: "Pending IFS", "Classifications(s)": "C39| C-43" }),
  mrow({ LicenseNo: "700002", BusinessName: "FLAGGED CONSTRUCTION", City: "SAN JOSE", County: "Santa Clara", BusinessType: "Corporation", ExpirationDate: "03/31/2027", PrimaryStatus: "CLEAR", "Classifications(s)": "B", DiscpCaseRegion: "NORTH" }),
].join("\n");
const PH = "LIC-NO,LastUpdated,REC-TP,SEQ-NO,Name-TP,Name,EMP-Titl-CDE,CL-CDE,CL-CDE-STAT,ASSN-DT,DIS-ASSN-DT,SURETY-TP";
const prow = (lic: string, seq: string, tp: string, name: string, title: string, dis: string) => [lic, "01/01/2024", "Class/Title", seq, tp, name, title, "", "", "", dis, ""].map((v) => (/[,"]/.test(v) ? `"${v}"` : v)).join(",");
const pad = (l: string, f: string, m = "") => ` ${l.padEnd(35)}${f.padEnd(15)}${m}`;
const personnel = [PH,
  prow("1000002", "1", " Principal", pad("DOCKERY", "RANDALL", "MARK"), " Sole Owner", " "),
  prow("632600", "2", " Principal", pad("CHEEK", "DAVID", "WILLIAM"), " Responsible Managing Officer/Chief Executive Officer/President", " "),
  prow("632600", "3", " Principal", pad("CHEEK", "JEANNE"), " Officer", " "),
  prow("632600", "4", " Principal", pad("CHEEK", "WILLIAM", "BURR"), " Responsible Managing Officer| Responsible Managing Officer", " 10/28/2003| 06/30/2006"),
  prow("632600", "5", " Business", "SOME ENTITY", " Entity (JV)", " "),
  prow("700001", "6", " Principal", pad("ROOFER", "RICK"), " Responsible Managing Employee", " "),
  prow("700002", "7", " Principal", pad("DEAD", "DAN"), " Deceased", " "),
  prow("700002", "8", " Principal", pad("FLAG", "FRED"), " Responsible Managing Officer", " "),
  prow("999999", "9", " Principal", pad("ORPHAN", "OLLIE"), " Officer", " "),
].join("\n");
const { rows, stats } = parseCslb(master, personnel);
assert.equal(stats.licenses, 4); assert.equal(stats.businessRows, 4); assert.equal(stats.personRows, 5); assert.equal(stats.personnelHistorical, 1); assert.equal(stats.personnelNonPerson, 1); assert.equal(stats.personnelDeceased, 1); assert.equal(stats.personnelOrphans, 1);
for (const r of rows) assert.deepEqual(licenseProblems(r.record), [], r.record.license_holder_name);
assert.equal(new Set(rows.map((r) => r.record_key)).size, rows.length, "record keys are unique");
const by = (lic: string) => rows.filter((r) => r.record.license_number === lic).map((r) => r.record);
const sole = by("1000002"); assert.equal(sole.length, 2); const soleP = sole.find((r) => r.holder_kind === "individual")!;
assert.equal(soleP.license_holder_name, "RANDALL MARK DOCKERY"); assert.equal(soleP.details.qualifier, true); assert.equal(soleP.license_type, "Well Drilling (Water) (C57)"); assert.equal(soleP.expiration_date, "2027-01-31"); assert.equal(soleP.status_raw, "CLEAR");
assert.equal(rows.find((r) => r.record.license_number === "1000002" && r.record.holder_kind === "individual")!.last_name, "DOCKERY");
// no address, phone, mailing address anywhere in the stored record
for (const r of rows) { const j = JSON.stringify(r.record); assert.ok(!/MILLS AVENUE|383 0487|925/.test(j), "no street address / phone is kept"); assert.ok(!("address" in r.record.details) && !("phone" in r.record.details)); assert.equal(r.record.details.city !== undefined, true); }
const corp = by("632600").filter((r) => r.holder_kind === "individual"); assert.equal(corp.length, 2, "the officer whose every association ended, and the JV entity, are not people on the license");
assert.equal(corp.find((r) => r.license_holder_name === "DAVID WILLIAM CHEEK")!.details.qualifier, true); assert.equal(corp.find((r) => r.license_holder_name === "JEANNE CHEEK")!.details.qualifier, false);
assert.equal(by("700001").find((r) => r.holder_kind === "business")!.license_holder_name, 'ACME, "QUALITY" ROOFING INC', "quoted business name round-trips");
assert.equal(by("700001")[0].status, "suspended"); assert.equal(by("700001")[0].status_raw, "Contr Bond Susp; Pending IFS"); assert.equal(by("700001")[0].license_type, "Roofing (C39); Sheet Metal (C43)");
assert.equal(by("700002").find((r) => r.holder_kind === "business")!.details.discipline, true);

// ---- adapter rules for ca-cslb
const P = LICENSE_PROFILES["ca-cslb"]; assert.ok(P);
const hold = (r: Partial<LicenseRow>) => standingFor({ license_holder_name: "A B", license_number: "1", license_type: "General Building Contractor (B)", status: "active", status_raw: "CLEAR", issue_date: null, expiration_date: "2027-06-30", details: {}, ...r } as LicenseRow, P, "2026-10-01");
assert.equal(hold({}).standing, "active"); assert.equal(hold({ details: { qualifier: true } }).standing, "active");
assert.equal(hold({ details: { qualifier: false } }).standing, "indeterminate"); assert.match(hold({ details: { qualifier: false } }).note ?? "", /not as its qualifying individual/);
assert.equal(hold({ details: { qualifier: true, discipline: true } }).standing, "indeterminate");
for (const s of ["CLEAR; WC Susp Pending", "CLEAR; Pending Case/CIT", "CLEAR; Renewal Recived", "Contr Bond Susp", "Work Comp Susp", "Liab Ins Susp", "INACTIVE", "Anything New"]) assert.equal(hold({ status_raw: s }).standing, "indeterminate", s);
assert.equal(hold({ expiration_date: "2026-09-30" }).standing, "indeterminate", "CLEAR but past its own expiration date");
const reg = (rows2: Array<{ source_id: string; record: LicenseRow }>): FetchRegistry => async (b) => {
  const hits: RegistryHit[] = rows2.filter((r) => r.record.license_number === b.license_number); return { ok: true, hits, reports: [{ source_id: "ca-cslb", ok: true, count: hits.length }, { source_id: "ca-dca", ok: true, count: 0 }] };
};
const toRow = (r: ReturnType<typeof by>[number]): LicenseRow => ({ ...r, details: r.details } as LicenseRow);
const fx = rows.map((r) => ({ source_id: "ca-cslb", record: toRow(r.record) }));
const look = (num: string, first: string, last: string) => registryLookup({ state: "CA", licenseNumber: num, firstName: first, lastName: last, today: "2026-10-01" }, reg(fx));
{ const r = await look("1000002", "Randall", "Dockery"); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].standing === "active", "sole owner: business row + person row collapse to ONE active license"); }
{ const r = await look("632600", "David", "Cheek"); assert.ok(r.ok && r.records.some((x) => x.nameMatches && x.standing === "active"), "the qualifying officer verifies"); }
{ const r = await look("632600", "Jeanne", "Cheek"); assert.ok(r.ok && r.records.some((x) => x.nameMatches && x.standing === "indeterminate"), "an officer who is not the qualifier is held, not passed"); }
{ const r = await look("700002", "Fred", "Flag"); assert.ok(r.ok && r.records.some((x) => x.nameMatches && x.standing === "indeterminate"), "disciplinary case on record: held"); }
{ const r = await look("632600", "Zed", "Stranger"); assert.ok(r.ok && r.records.length === 0, "a stranger under a real number is dropped (shared numbering): not found"); }

// ---- real files (optional)
const dir = process.argv[2];
if (dir) {
  const t = parseCslb(fs.readFileSync(`${dir}/license_master.csv`, "latin1"), fs.readFileSync(`${dir}/personnel.csv`, "latin1"));
  assert.equal(t.stats.licenses, 245529); assert.equal(t.rows.length, 566617); assert.equal(t.stats.personnelRows, 407947);
  let bad = 0; for (const r of t.rows) if (licenseProblems(r.record).length) bad++; assert.equal(bad, 0);
  assert.equal(new Set(t.rows.map((r) => r.record_key)).size, t.rows.length);
  console.log(`cslb real files: ${t.stats.licenses} licenses -> ${t.rows.length} records (${t.stats.personRows} people), 0 schema problems, unique keys`);
}
console.log("cslb: csv, status, classes, names, personnel association, parse (no address/phone kept), adapter holds (non-qualifier, discipline, any non-CLEAR), collapse - all passed");
