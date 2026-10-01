// Offline tests for the registry-backed license adapters (supabase/functions/_shared/registry/license-adapter.ts). Every status string below was seen
// on a live row on 2026-10-01; the fake registry mimics registry-lookup (exact number match, 50-row cap + truncated flag, name search).
import assert from "node:assert/strict";
import {
  LICENSE_PROFILES, STATE_SOURCES, standingFor, nameMatches, numbersEqual, numbersEqualFor, numberVariants, registryLookup, notFoundNote, nameMatchesLastFirst,
  type LicenseRow, type FetchRegistry, type RegistryHit,
} from "../../supabase/functions/_shared/registry/license-adapter.ts";

const TODAY = "2026-10-01";
const row = (o: Partial<LicenseRow> & { license_holder_name: string; license_number: string }): LicenseRow => ({
  license_type: "Registered Nurse", status: "active", status_raw: "Active", issue_date: "2015-01-01", expiration_date: "2027-09-30", board_agency: "B", details: {}, ...o,
});
const st = (src: string, status_raw: string | null, extra: Partial<LicenseRow> = {}) =>
  standingFor(row({ license_holder_name: "A B", license_number: "1", status_raw, ...extra }), LICENSE_PROFILES[src], TODAY).standing;

// ---------------------------------------------------------------- 1. standing: clean active passes, qualified/unknown never does
for (const [src, clean] of [["co-dora", "Active"], ["il-idfpr", "ACTIVE"], ["wa-doh", "Active"], ["wa-lni", "ACTIVE"], ["de-dpr", "Active"], ["ca-dca", "Current"], ["mi-lara", "Active"]] as const) {
  assert.equal(st(src, clean), "active", `${src}: ${clean}`);
  assert.equal(st(src, clean.toLowerCase()), "active", `${src}: case-insensitive`);
  assert.equal(st(src, null), "indeterminate", `${src}: no status text is never active`);
  assert.equal(st(src, "Some Brand New Status"), "indeterminate", `${src}: unseen status is never guessed`);
}
// the qualified actives the shared normalizer would have called plain "active"
for (const s of ["Active - With Conditions", "Active - Provisional", "Active - Telehealth ONLY", "Active - Restricted", "Active - Refresher Course Only", "Active - Reentry License",
  "Transferred to Compact Physician", "Grad to Higher Level", "Need Master Hire - Cannot Practice"]) assert.equal(st("co-dora", s), "indeterminate", `CO ${s}`);
for (const s of ["ACTIVE CHAPERONE REQUIRED", "PROBATION", "Non Sufficient Fund Check"]) assert.equal(st("il-idfpr", s), "indeterminate", `IL ${s}`);
for (const s of ["Active With Conditions", "Active With Restrictions", "Active On Probation", "Active Provisional", "Active Not Renewable", "Retired Active", "Retired Active In-State",
  "Military", "Expired – Active MSL", "Closed", "Superseded", "Inoperable", "Pending", "Approved", "Denied"]) assert.equal(st("wa-doh", s), "indeterminate", `WA DOH ${s}`);
for (const s of ["RE-LICENSED", "SUPERCEDED"]) assert.equal(st("wa-lni", s), "indeterminate", `WA L&I ${s}`);
for (const s of ["Probation", "Delinquent", "Non-Disciplinary Suspension", "Under Review"]) assert.equal(st("de-dpr", s), "indeterminate", `DE ${s}`);
assert.equal(st("ca-dca", "Delinquent"), "indeterminate", "CA delinquent = renewal overdue, neither a pass nor a negative");
assert.equal(st("mi-lara", "Active - In Late Renewal"), "indeterminate"); for (const s of ["Limited", "Disciplinary Limited", "Voluntary Limited"]) assert.equal(st("mi-lara", s), "indeterminate", `MI ${s}`);
// definitively ended
for (const s of ["Revoked", "Surrendered", "Voluntary Surrender", "Cancelled", "Suspended", "Suspended Due to Child Support", "Summary Suspension", "Retired", "Expired - Dissolved"]) assert.equal(st("co-dora", s), "inactive", `CO ${s}`);
for (const s of ["REVOKED", "SUSPENDED", "CANCELLED", "TERMINATED", "DECEASED", "RELINQUISH", "VOLUNTARY SURRENDER", "REVOKED CHAPERONE REQUIRED", "INOPERATIVE", "CLOSED"]) assert.equal(st("il-idfpr", s), "inactive", `IL ${s}`);
for (const s of ["Suspended", "Revoked", "Terminated", "Surrender", "Voluntary Surrender", "Summary Suspension", "Retired"]) assert.equal(st("wa-doh", s), "inactive", `WA DOH ${s}`);
for (const s of ["SUSPENDED", "REVOKED DUE DEPT ERR", "PASSED AWAY", "OUT OF BUSINESS"]) assert.equal(st("wa-lni", s), "inactive", `WA L&I ${s}`);
for (const s of ["Suspended", "Revoked", "Annulled", "Deceased", "Withdrawn", "Denied", "Terminated"]) assert.equal(st("de-dpr", s), "inactive", `DE ${s}`);
assert.equal(st("ca-dca", "Suspension"), "inactive"); assert.equal(st("mi-lara", "Suspended"), "inactive");
// lapsed: definitive on a live list, NOT on a monthly snapshot (it can be a month stale)
for (const [src, s] of [["co-dora", "Expired"], ["co-dora", "Beyond 6 Years Expired"], ["co-dora", "Inactive"], ["il-idfpr", "NOT RENEWED"], ["il-idfpr", "EXPIRED"], ["wa-doh", "Expired"], ["wa-lni", "EXPIRED"], ["de-dpr", "Expired"], ["de-dpr", "Closed"]] as const)
  assert.equal(st(src, s), "inactive", `${src} ${s}`);
for (const s of ["CurrentInactive", "Inactive", "Expired"]) assert.equal(st("ca-dca", s), "indeterminate", `CA snapshot ${s} is not proof`);
// Connecticut: status + reason
const ct = (status_raw: string, reason: string | null) => st("ct-dcp", status_raw, { details: { status_reason: reason } });
for (const r of ["CURRENT", "ACTIVE", "ACCEPTED", "REGISTERED", "CERTIFICATION", "CERTIFIED", "LICENSED", "PERMITTED", "IN RENEWAL", null]) assert.equal(ct("ACTIVE", r), "active", `CT ACTIVE|${r}`);
assert.equal(ct("ACTIVE IN RENEWAL", "CURRENT"), "active"); assert.equal(ct("ACTIVE", "SOMETHING NEW"), "indeterminate", "an unseen reason on an ACTIVE row is not a pass");
for (const [s, r] of [["INACTIVE", "LAPSED DUE TO NON-RENEWAL"], ["INACTIVE", "TERMINATED"], ["INACTIVE", null], ["LAPSED", null], ["RETIRED", "NOT ACTIVELY ENGAGING"], ["DENIED", "FAILED APPLICATION"]] as const) assert.equal(ct(s, r), "inactive", `CT ${s}|${r}`);
for (const [s, r] of [["PENDING", "PENDING"], ["APPROVED", "CURRENT"], ["QUALIFIED", "NONE"], ["EXPIRED APPLICATION", "EXPIRED APPLICATION"]] as const) assert.equal(ct(s, r), "indeterminate", `CT ${s}`);
// a clean active whose own expiration date has passed is stale / mid-renewal, never a pass
const stale = standingFor(row({ license_holder_name: "A B", license_number: "1", expiration_date: "2026-09-01" }), LICENSE_PROFILES["co-dora"], TODAY);
assert.equal(stale.standing, "indeterminate"); assert.match(stale.note ?? "", /expiration date has already passed/);
assert.equal(standingFor(row({ license_holder_name: "A B", license_number: "1", expiration_date: "2026-10-01" }), LICENSE_PROFILES["co-dora"], TODAY).standing, "active", "expiring today is still valid");
assert.equal(standingFor(row({ license_holder_name: "A B", license_number: "1", expiration_date: null }), LICENSE_PROFILES["co-dora"], TODAY).standing, "active", "no expiration date on file does not block a clean active");

// ---------------------------------------------------------------- 2. names
assert.ok(nameMatches("Hilliary", "Lucido", "Hilliary Elizabeth Lucido"), "middle name in the registry is allowed");
assert.ok(nameMatches("hilliary", "LUCIDO", "HILLIARY LUCIDO")); assert.ok(nameMatches("Mary Ann", "Smith", "MARY ANN SMITH"));
assert.ok(nameMatches("Jose", "Garcia", "José Garcia"), "accents are folded"); assert.ok(nameMatches("Maria", "De La Cruz", "MARIA DE LA CRUZ"), "multi-word last names");
assert.ok(nameMatches("John", "O'Brien", "JOHN OBRIEN")); assert.ok(nameMatches("John", "Smith-Jones", "JOHN SMITH JONES"));
assert.ok(nameMatches("John", "Smith", "JOHN A SMITH JR"), "registry suffix ignored"); assert.ok(nameMatches("John", "Smith Jr.", "JOHN SMITH"), "candidate suffix ignored");
assert.ok(!nameMatches("Maria", "Garcia", "MARIAM GARCIA"), "a longer first name is a different person"); assert.ok(!nameMatches("Maria", "Garcia", "MARIA GARCIA-LOPEZ"));
assert.ok(!nameMatches("John", "Smith", "SMITH"), "a one-token registry name never matches"); assert.ok(!nameMatches("", "Smith", "JOHN SMITH")); assert.ok(!nameMatches("John", "Smith", "JOHNSON SMITH"));
assert.ok(!nameMatches("John", "Smith", "SMITH JOHN"), "order matters: no swapped-name guess");

// ---------------------------------------------------------------- 3. numbers
assert.ok(numbersEqual("000159568", "159568")); assert.ok(numbersEqual("L1-0055996", "L10055996")); assert.ok(numbersEqual("rn.0012345", "RN0012345")); assert.ok(!numbersEqual("12345", "12346")); assert.ok(!numbersEqual("", "")); assert.ok(!numbersEqual("RN123", "123"));
const pro = (...i: string[]) => i.map((x) => LICENSE_PROFILES[x]);
assert.deepEqual(numberVariants("041293224", pro("il-idfpr")), ["041293224", "41293224"]);
assert.ok(numberVariants("41293224", pro("il-idfpr")).includes("041293224"), "IL stores 9-digit zero-padded numbers");
assert.ok(numberVariants("159568", pro("co-dora")).includes("000159568"), "CO COS numbers are zero-padded to 9");
assert.deepEqual(numberVariants("4704171261", pro("mi-lara")), ["4704171261"], "Michigan numbers are not padded: one search form"); assert.ok(numberVariants("L10055996", pro("de-dpr")).includes("L1-0055996"), "DE hyphen form");
assert.ok(numberVariants(" lpn.lp.00059315 ", pro("wa-doh", "wa-lni")).includes("LPN.LP.00059315"));
assert.ok(numberVariants("1", pro("co-dora")).length <= 5);

// ---------------------------------------------------------------- 4. lookup against a fake registry
function fakeRegistry(rows: Array<{ source_id: string; record: LicenseRow }>, opts: { limit?: number; failSource?: string } = {}): FetchRegistry & { calls: Array<Record<string, unknown>> } {
  const f = (async (body: Record<string, unknown>) => {
    f.calls.push(body);
    const states = (body.states as string[]) ?? []; const limit = Math.min(Number(body.limit) || 10, opts.limit ?? 50);
    const ids = new Set(states.flatMap((s) => STATE_SOURCES[s] ?? []));
    const reports: Array<{ source_id: string; ok: boolean; count: number; truncated?: boolean; error?: string }> = []; const hits: RegistryHit[] = [];
    for (const id of ids) {
      if (opts.failSource === id) { reports.push({ source_id: id, ok: false, count: 0, error: "http_503" }); continue; }
      let m = rows.filter((r) => r.source_id === id);
      if (body.license_number) m = m.filter((r) => r.record.license_number === body.license_number);
      else if (body.first_name && body.last_name) m = m.filter((r) => r.record.license_holder_name.toUpperCase().includes(String(body.last_name).toUpperCase()) && r.record.license_holder_name.toUpperCase().startsWith(String(body.first_name).toUpperCase()));
      const cut = m.slice(0, limit); hits.push(...cut); reports.push({ source_id: id, ok: true, count: cut.length, truncated: cut.length >= limit });
    }
    return { ok: true as const, hits, reports };
  }) as FetchRegistry & { calls: Array<Record<string, unknown>> };
  f.calls = []; return f;
}
const R = (source_id: string, o: Partial<LicenseRow> & { license_holder_name: string; license_number: string }) => ({ source_id, record: row(o) });
const look = (state: string, num: string, first: string, last: string, reg: FetchRegistry) => registryLookup({ state, licenseNumber: num, firstName: first, lastName: last, today: TODAY }, reg);

{ // Colorado: exact, active
  const reg = fakeRegistry([R("co-dora", { license_holder_name: "Hilliary Elizabeth Lucido", license_number: "167517", license_type: "RN" })]);
  const r = await look("CO", "167517", "Hilliary", "Lucido", reg); assert.ok(r.ok);
  assert.equal(r.records.length, 1); assert.equal(r.records[0].nameMatches, true); assert.equal(r.records[0].standing, "active"); assert.equal(r.records[0].licenseType, "RN"); assert.equal(r.capped, false);
  assert.equal(reg.calls.length, 1, "found on the first number form: no extra registry calls");
}
{ // Colorado: qualified active is held, not passed
  const reg = fakeRegistry([R("co-dora", { license_holder_name: "Pat Q Smith", license_number: "5555", status_raw: "Active - With Conditions" })]);
  const r = await look("CO", "5555", "Pat", "Smith", reg); assert.ok(r.ok && r.records[0].standing === "indeterminate");
}
{ // Colorado numbers are shared across boards: strangers with the same number are dropped, so a wrong number is a clean not-found (records = [])
  const reg = fakeRegistry([R("co-dora", { license_holder_name: "Alice Stranger", license_number: "23840", license_type: "AP" }), R("co-dora", { license_holder_name: "Bob Other", license_number: "23840", license_type: "PN" })]);
  const r = await look("CO", "23840", "Hilliary", "Lucido", reg); assert.ok(r.ok && r.records.length === 0, "shared-number strangers never become a 'name mismatch'");
}
{ // Colorado: the number carries a zero-padded form
  const reg = fakeRegistry([R("co-dora", { license_holder_name: "Cora Cosmo", license_number: "000159568", license_type: "COS" })]);
  const r = await look("CO", "159568", "Cora", "Cosmo", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches, "found through the zero-padded variant");
}
{ // REGRESSION (found live 2026-10-01): the bare number matched a stranger on another board, which used to end the search before the zero-padded form was tried
  const reg = fakeRegistry([R("co-dora", { license_holder_name: "Someone Else", license_number: "159568", license_type: "RN" }), R("co-dora", { license_holder_name: "Elisia Sandoval", license_number: "000159568", license_type: "COS" })]);
  const r = await look("CO", "159568", "Elisia", "Sandoval", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].licenseType === "COS", "the holder is found through the padded form even though a stranger matched the bare one");
  assert.ok(reg.calls.some((c) => c.license_number === "000159568"));
}
{ // Illinois: unique-number source: same number, different holder IS a name mismatch (maiden name case) and goes to a human
  const reg = fakeRegistry([R("il-idfpr", { license_holder_name: "MARIA GARCIA", license_number: "011241964", license_type: "LICENSED COSMETOLOGIST", status_raw: "ACTIVE" })]);
  const r = await look("IL", "011241964", "Maria", "Lopez", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches === false);
}
{ // Illinois: identical duplicate rows (the dataset repeats rows) are one license
  const a = { license_holder_name: "MARIA GARCIA", license_number: "011241964", license_type: "LICENSED COSMETOLOGIST", status_raw: "ACTIVE" };
  const r = await look("IL", "011241964", "Maria", "Garcia", fakeRegistry([R("il-idfpr", a), R("il-idfpr", a)])); assert.ok(r.ok && r.records.length === 1 && r.records[0].standing === "active");
}
{ // California: NP + NP Furnishing under one number and one holder = ONE license; mixed statuses are held
  const base = { license_holder_name: "MARIA A GARCIA", license_number: "95002690", board_agency: "Board of Registered Nursing" };
  const r1 = await look("CA", "95002690", "Maria", "Garcia", fakeRegistry([R("ca-dca", { ...base, license_type: "Nurse Practitioner", status_raw: "Current" }), R("ca-dca", { ...base, license_type: "Nurse Practitioner Furnishing", status_raw: "Current" })]));
  assert.ok(r1.ok && r1.records.length === 1 && r1.records[0].standing === "active" && /Nurse Practitioner/.test(r1.records[0].licenseType ?? ""));
  const r2 = await look("CA", "95002690", "Maria", "Garcia", fakeRegistry([R("ca-dca", { ...base, license_type: "Nurse Practitioner", status_raw: "Current" }), R("ca-dca", { ...base, license_type: "Nurse Practitioner Furnishing", status_raw: "Delinquent" })]));
  assert.ok(r2.ok && r2.records.length === 1 && r2.records[0].standing === "indeterminate", "one active, one delinquent: a human decides");
  // CA number shared with another board's holder: dropped; same number on a DIFFERENT board for the SAME name stays separate (not collapsed across boards)
  const r3 = await look("CA", "584996", "Maria", "Garcia", fakeRegistry([R("ca-dca", { license_holder_name: "MARIA A GARCIA", license_number: "584996", board_agency: "Board of Registered Nursing" }), R("ca-dca", { license_holder_name: "MARIA A GARCIA", license_number: "584996", board_agency: "Dental Board", license_type: "Dentist" })]));
  assert.ok(r3.ok && r3.records.length === 2, "same number + name on two different boards is two rows (decide() will not call that a single match)");
}
{ // Michigan: monthly active-only roster; late renewal is held
  const r = await look("MI", "4704171261", "James", "Miller", fakeRegistry([R("mi-lara", { license_holder_name: "James Edward Miller", license_number: "4704171261", status_raw: "Active - In Late Renewal" })]));
  assert.ok(r.ok && r.records[0].standing === "indeterminate");
  const r2 = await look("MI", "4704171261", "James", "Miller", fakeRegistry([R("mi-lara", { license_holder_name: "James Edward Miller", license_number: "4704171261", status_raw: "Active" })]));
  assert.ok(r2.ok && r2.records.length === 1 && r2.records[0].standing === "active");
}
{ // Washington has two sources: DOH (individual) and L&I (business; the person is the principal)
  const reg = fakeRegistry([
    R("wa-lni", { license_holder_name: "!ECO STAR C G CONSTRUCTION LLC", license_number: "ECOSTCG123ZA", license_type: "CONSTRUCTION CONTRACTOR", status_raw: "ACTIVE", details: { principal: "GUERRERO MARTINEZ, CARLOS" } }),
    R("wa-doh", { license_holder_name: "Rocky Dean Buckham", license_number: "NAC.NC.60123456", license_type: "Nursing Assistant Certification", status_raw: "Expired" }),
  ]);
  const lni = await look("WA", "ECOSTCG123ZA", "Carlos", "Guerrero Martinez", reg); assert.ok(lni.ok && lni.records.length === 1 && lni.records[0].nameMatches && lni.records[0].standing === "active", "sole proprietor matched through the principal's name");
  const doh = await look("WA", "NAC.NC.60123456", "Rocky", "Buckham", reg); assert.ok(doh.ok && doh.records[0].standing === "inactive", "WA DOH 'Expired' on a live list is a definitive lapse");
}
{ // not found: no row carries the number
  const r = await look("DE", "L1-0099999", "John", "Smith", fakeRegistry([R("de-dpr", { license_holder_name: "JOHN SMITH", license_number: "L1-0042067" })])); assert.ok(r.ok && r.records.length === 0 && r.capped === false);
}
{ // a short shared number hits the cap: the person is looked up by NAME instead, so the cap cannot hide them
  const strangers = Array.from({ length: 60 }, (_, i) => R("co-dora", { license_holder_name: `Person${i} Zed${i}`, license_number: "7", license_type: `T${i}` }));
  const mine = R("co-dora", { license_holder_name: "Hilliary Lucido", license_number: "7", license_type: "RN" });
  const reg = fakeRegistry([...strangers, mine]);
  const r = await look("CO", "7", "Hilliary", "Lucido", reg); assert.ok(r.ok && r.records.some((x) => x.nameMatches), "found by name behind a capped number search");
  assert.ok(reg.calls.some((c) => c.first_name === "Hilliary"), "the name fallback ran");
  // the name search resolves the cap: holder not present under this number -> a clean miss (records = []), not "capped"
  const reg2 = fakeRegistry(strangers); const r2 = await look("CO", "7", "Hilliary", "Lucido", reg2); assert.ok(r2.ok && r2.records.length === 0 && r2.capped === false, "an uncapped name search that does not find the number proves absence");
  // ... but if the NAME search is capped too (60 same-named people), absence is NOT proven: capped -> a human decides
  const namesakes = Array.from({ length: 60 }, (_, i) => R("co-dora", { license_holder_name: "Hilliary Lucido", license_number: `9${i}`, license_type: `T${i}` }));
  const reg3 = fakeRegistry([...strangers, ...namesakes]); const r3 = await look("CO", "7", "Hilliary", "Lucido", reg3); assert.ok(r3.ok && r3.capped === true && r3.records.length === 0, "both searches full and no hit: capped, never a clean miss");
}
{ // registry failures are never "not found"
  const r = await look("DE", "L1-1", "John", "Smith", fakeRegistry([], { failSource: "de-dpr" })); assert.ok(!r.ok && r.error === "http_503");
  const r2 = await look("WA", "X", "A", "B", fakeRegistry([], { failSource: "wa-lni" })); assert.ok(!r2.ok, "one failed WA source is a failure, not a hit on the other");
  const r3 = await registryLookup({ state: "FL", licenseNumber: "1", firstName: "A", lastName: "B" }, fakeRegistry([])); assert.ok(!r3.ok && r3.error === "no_registry_profile_for_state");
  const throws: FetchRegistry = async () => ({ ok: false, error: "network_error", detail: "boom" }); const r4 = await look("CO", "1", "A", "B", throws); assert.ok(!r4.ok && r4.error === "network_error");
}

// ---------------------------------------------------------------- 5. Texas (Board of Nursing RN + VN, TREC) and the discipline hold
for (const [src, clean] of [["tx-bon-rn", "CURRENT (C)"], ["tx-bon-vn", "CURRENT (C)"], ["tx-trec", "Active"]] as const) assert.equal(st(src, clean), "active", `${src}`);
// every real Texas Board of Nursing status (counts from 2026-10-01): only CURRENT passes
for (const s of ["DELINQUENT (D)", "VOLUNTEER RETIRED (W)", "NLC LICENSE - TX INVALID(Y)", "Current RENEWAL DENIED (K)", "NOT CURRENT - SEE ENF (X)"]) assert.equal(st("tx-bon-rn", s), "indeterminate", `TX BON ${s}`);
for (const s of ["REVOKED (R)", "SUSPENDED (S)", "VOL.SURRENDER (V)", "DECEASED (E)", "RETIRED - INACTIVE (Z)"]) assert.equal(st("tx-bon-rn", s), "inactive", `TX BON ${s}`);
assert.equal(st("tx-bon-rn", "INACTIVE (I)"), "indeterminate", "monthly list: a lapse is not proof");
// every real TREC status
for (const s of ["Closed - Upgraded", "Probation - Active", "Probation - Inactive", "Probated Suspension - Active", "Military"]) assert.equal(st("tx-trec", s), "indeterminate", `TREC ${s}`);
for (const s of ["Revoked", "Suspended", "Surrendered", "Deceased", "Expired less than 6 months", "Expired more than 6 months", "Inactive"]) assert.equal(st("tx-trec", s), "inactive", `TREC ${s}`);
// discipline marker on an otherwise clean active row: held, with the reason in the status text staff read
const held = (src: string, details: Record<string, unknown>, status_raw: string) => standingFor(row({ license_holder_name: "A B", license_number: "1", status_raw, details }), LICENSE_PROFILES[src], TODAY);
assert.equal(held("tx-bon-rn", { board_action: true }, "CURRENT (C)").standing, "indeterminate"); assert.match(held("tx-bon-rn", { board_action: true }, "CURRENT (C)").note ?? "", /Board of Nursing action/);
assert.equal(held("tx-bon-rn", { board_action: false }, "CURRENT (C)").standing, "active");
assert.equal(held("il-idfpr", { ever_disciplined: "Y" }, "ACTIVE").standing, "indeterminate"); assert.equal(held("il-idfpr", { ever_disciplined: "N" }, "ACTIVE").standing, "active");
assert.equal(held("wa-doh", { action_taken: "Yes" }, "Active").standing, "indeterminate"); assert.equal(held("wa-doh", { action_taken: "Pending" }, "Active").standing, "indeterminate"); assert.equal(held("wa-doh", { action_taken: "No" }, "Active").standing, "active");
assert.equal(held("co-dora", { program_action: "CLS Letter of Admonition" }, "Active").standing, "indeterminate"); assert.equal(held("co-dora", { program_action: null }, "Active").standing, "active");
assert.equal(held("wa-doh", { action_taken: "Yes" }, "Expired").standing, "inactive", "a hold only changes an otherwise-clean ACTIVE row; a lapsed one stays lapsed");
// TREC number suffixes
assert.ok(numbersEqualFor("763827-SA", "763827", LICENSE_PROFILES["tx-trec"]), "a bare number from a resume matches the suffixed stored number"); assert.ok(!numbersEqualFor("763827-SA", "763827"), "...only for a source that declares suffixes");
assert.ok(numbersEqualFor("100097-B", "100097B", LICENSE_PROFILES["tx-trec"])); assert.ok(!numbersEqualFor("763827-SA", "763828", LICENSE_PROFILES["tx-trec"]));
const vs = numberVariants("763827", pro("tx-bon-rn", "tx-bon-vn", "tx-trec")); for (const w of ["763827", "763827-SA", "763827-B", "763827-BB"]) assert.ok(vs.includes(w), `variant ${w}`);
assert.ok(numberVariants("763827SA", pro("tx-trec")).includes("763827-SA"));
{ // TX: a real-estate agent's bare number is found through the suffix variant; the RN and VN datasets hold strangers under the same number -> dropped
  const reg = fakeRegistry([
    R("tx-trec", { license_holder_name: "JOHN YI SMITH", license_number: "763827-SA", license_type: "Sales Agent", status_raw: "Active" }),
    R("tx-bon-rn", { license_holder_name: "ZED STRANGER", license_number: "763827", license_type: "Registered Nurse", status_raw: "CURRENT (C)" }),
    R("tx-bon-vn", { license_holder_name: "ALICE OTHER", license_number: "763827", license_type: "Vocational Nurse", status_raw: "CURRENT (C)" }),
  ]);
  const r = await look("TX", "763827", "John", "Smith", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].standing === "active" && r.records[0].licenseType === "Sales Agent", "found as the sales agent; the same-number nurses are strangers");
}
{ // TX RN: current + board action -> held; current clean -> active; delinquent -> held
  const mk = (extra: Partial<LicenseRow>) => fakeRegistry([R("tx-bon-rn", { license_holder_name: "JOHN LEE SMITH", license_number: "460453", license_type: "Registered Nurse", status_raw: "CURRENT (C)", ...extra })]);
  assert.equal(((await look("TX", "460453", "John", "Smith", mk({}))) as any).records[0].standing, "active");
  assert.equal(((await look("TX", "460453", "John", "Smith", mk({ details: { board_action: true } }))) as any).records[0].standing, "indeterminate");
  assert.equal(((await look("TX", "460453", "John", "Smith", mk({ status_raw: "DELINQUENT (D)" }))) as any).records[0].standing, "indeterminate");
}
assert.match(notFoundNote("TX"), /Texas Board of Nursing/); assert.match(notFoundNote("TX"), /Real Estate Commission/);

// ---------------------------------------------------------------- 6. New York (last-first names, active-only lists), Oregon, Washington CPA
assert.ok(nameMatchesLastFirst("Beth", "Acocella", "ACOCELLA BETH A"), "NY stores LAST FIRST MIDDLE"); assert.ok(nameMatchesLastFirst("Luz Maria", "Diaz Arias", "DIAZ ARIAS LUZ MARIA"), "multi-word last name and first name");
assert.ok(nameMatchesLastFirst("Beth", "Acocella", "ACOCELLA BETH")); assert.ok(nameMatchesLastFirst("John", "Smith", "SMITH JOHN A JR"));
assert.ok(!nameMatchesLastFirst("John", "Smith", "JOHN SMITH"), "a first-last name is NOT a last-first match: order matters"); assert.ok(!nameMatchesLastFirst("John", "Smith", "SMITH JOHNSON"), "a longer first name is another person");
assert.ok(!nameMatchesLastFirst("Beth", "Acocella", "ACOCELLA"), "one token never matches"); assert.ok(!nameMatchesLastFirst("Beth", "Acocella", "ACOCELLO BETH"));
// an active-only list with no status column: membership = active, but an expiration date that has already passed is never a pass
const imp = (src: string, exp: string | null, extra: Partial<LicenseRow> = {}) => standingFor(row({ license_holder_name: "A B", license_number: "1", status_raw: null, expiration_date: exp, ...extra }), LICENSE_PROFILES[src], TODAY);
for (const src of ["ny-dos-re", "ny-dos-appearance", "or-ccb"]) { assert.equal(imp(src, "2027-01-01").standing, "active", `${src} implicit active`); assert.equal(imp(src, "2026-09-30").standing, "indeterminate", `${src} past its own expiration`); assert.equal(imp(src, null).standing, "active", `${src} no date on file`); }
assert.equal(imp("or-bcd", "2027-01-01", { status_raw: "Active" }).standing, "active"); assert.equal(imp("or-bcd", "2027-01-01", { status_raw: "Something New" }).standing, "indeterminate"); assert.equal(imp("or-bcd", "2027-01-01").standing, "indeterminate", "OR BCD has a status column: no text is not a pass");
// Washington CPA: every real status
assert.equal(st("wa-cpa", "Licensed to practice public accounting"), "active");
for (const s of ["Suspended per Board Order", "Licensed to practice Revoked per Board Order", "Deceased", "Retired Licensee", "Retired Certificate holder"]) assert.equal(st("wa-cpa", s), "inactive", `WA CPA ${s}`);
for (const s of ["Lapsed Licensee", "Lapsed Certificateholder", "Lapsed Registration", "Holds a CPA License in an Inactive status (not licensed to practice as a CPA)"]) assert.equal(st("wa-cpa", s), "inactive", `WA CPA ${s}`);
for (const s of ["ConvertedToCPA", "A non-CPA who is registered as an owner in a Washington CPA firm; may not use the title CPA"]) assert.equal(st("wa-cpa", s), "indeterminate", `WA CPA ${s}`);
assert.equal(held("wa-cpa", { board_order: "https://example/order.pdf" }, "Licensed to practice public accounting").standing, "indeterminate", "a Board order on record holds an otherwise active CPA");
assert.equal(held("wa-cpa", { board_order: null }, "Licensed to practice public accounting").standing, "active");
{ // New York: found through the last-first name; strangers with another name under the same number are mismatches (unique numbering)
  const reg = fakeRegistry([R("ny-dos-re", { license_holder_name: "ACOCELLA BETH A", license_number: "30AC0961210", license_type: "ASSOCIATE BROKER", status: "active", status_raw: null, expiration_date: "2028-02-24" })]);
  const ok = await look("NY", "30AC0961210", "Beth", "Acocella", reg); assert.ok(ok.ok && ok.records.length === 1 && ok.records[0].nameMatches && ok.records[0].standing === "active" && ok.records[0].licenseType === "ASSOCIATE BROKER");
  const wrongOrder = await look("NY", "30AC0961210", "Acocella", "Beth", reg); assert.ok(wrongOrder.ok && wrongOrder.records[0].nameMatches === false, "swapping first and last is not a match");
  const mismatch = await look("NY", "30AC0961210", "Mary", "Jones", reg); assert.ok(mismatch.ok && mismatch.records.length === 1 && !mismatch.records[0].nameMatches);
}
{ // Oregon CCB: the licensee is the business; the responsible managing individual's name matches
  const reg = fakeRegistry([R("or-ccb", { license_holder_name: "SOTOS CONCRETE LLC", license_number: "242649", license_type: "Residential General Contractor", status: "active", status_raw: null, expiration_date: "2026-10-25", details: { principal: "PEDRO SOTO MAGALLAN" } })]);
  const r = await look("OR", "242649", "Pedro", "Magallan", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].nameMatches && r.records[0].standing === "active", "matched through the RMI's name");
  const biz = await look("OR", "242649", "Sotos", "Concrete", reg); assert.ok(biz.ok && !biz.records[0]?.nameMatches, "a person's name does not match a business name");
}
{ // Washington has three sources now; a CPA number is found alongside DOH/L&I ones
  const reg = fakeRegistry([R("wa-cpa", { license_holder_name: "Mark A Ruzicka", license_number: "50762", license_type: "Certified Public Accountant", status_raw: "Licensed to practice public accounting", details: { board_order: null } })]);
  const r = await look("WA", "50762", "Mark", "Ruzicka", reg); assert.ok(r.ok && r.records.length === 1 && r.records[0].standing === "active");
}
assert.match(notFoundNote("NY"), /ACTIVE real estate/); assert.match(notFoundNote("NY"), /currently licensed holders only/); assert.match(notFoundNote("OR"), /Building Codes Division/); assert.match(notFoundNote("WA"), /Board of Accountancy/);

// honest not-found wording
assert.match(notFoundNote("MI"), /currently licensed holders only/); assert.match(notFoundNote("WA"), /health care provider[\s\S]*contractor licenses/); assert.match(notFoundNote("CA"), /Revoked and cancelled licenses do not appear/); assert.match(notFoundNote("CO"), /attorneys/); assert.doesNotMatch(notFoundNote("CO"), /currently licensed holders only/);
for (const [state, ids] of Object.entries(STATE_SOURCES)) for (const i of ids) { const p = LICENSE_PROFILES[i]; assert.equal(p.state, state); assert.ok(p.coverage.length > 20, `${i} has coverage wording`); }

console.log("license adapters: standing (clean active only; qualified/unknown held; lapsed definitive only on live lists), names, numbers, collapse, shared-number + cap handling, failures, honest coverage wording - all passed");
