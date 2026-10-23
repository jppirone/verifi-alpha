// node tools/resume/test-staff-block-hold.mjs   (no network, no model call, no live database; PGlite in this process and an in-memory stand-in for the REST side)
// BI (October 22, 2026): tests that John could not hand test and that never existed: a STAFF BLOCKED item and an item in an unresolved OVERLAP HOLD never reach the employer.
//  A. the SQL assembler assemble_customized_resume (the REAL function text from migration 20260927060000, run in PGlite on a stub schema): this is what the PDF, the Content Manager and the
//     employer's generated comparison document (assemble_plain_document calls it with overrides ignored and delivered only) are built from.
//  B. the edge assembler assembleResumeSnapshot (the REAL candidate-comparison-requests source, action assemble_live, against a stand-in): the verification status view and the coverage counts the employer sees.
// Each check has a planted bug that is shown to be caught. NOT proved: the real database (stub tables with the columns the function reads), PostgREST, the real PDF download.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const PGLITE = process.env.LOOKUP_SPLIT_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set LOOKUP_SPLIT_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);
const tests = []; const t = (name, fn) => tests.push([name, fn]);

// ================================================================== A. the SQL assembler
const OV = rd("supabase/migrations/20260927060000_work_overlap_detection.sql"), ST1 = rd("supabase/migrations/20260921090000_customization_stage1.sql");
const FN = OV.slice(OV.indexOf("create or replace function assemble_customized_resume"), OV.indexOf("end $function$;", OV.indexOf("create or replace function assemble_customized_resume")) + "end $function$;".length);
const HELPERS = ["_cz_pdate", "_cz_vstatus", "_cz_norm"].map((n) => { const a = ST1.indexOf("create or replace function " + n); return ST1.slice(a, ST1.indexOf("$$;", ST1.indexOf("$$", a) + 2) + 3); }).join("\n");
assert.ok(FN.length > 3000 && HELPERS.includes("_cz_norm"), "the real function text was found");
const SCHEMA = `
create table candidates (id uuid primary key, first_name text, last_name text, email text, account_type text, tier text default 'free', deletion_scheduled_at timestamptz, header_display_mode text, personal_location text, phone_verified_at timestamptz, verified_phone_number text);
create table resume_documents (id uuid primary key, candidate_id uuid, confirmed_at timestamptz, printed_header text);
create table candidate_customization (candidate_id uuid primary key, summary_mode text default 'default', printed_phone text, printed_email text, version int default 0, selected_summary_id uuid);
create table candidate_item_overrides (candidate_id uuid, kind text, item_id uuid, text_override text, base_text_hash text, included boolean default true, position int);
create table work_history_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, resume_document_id uuid, position int, heading text, company text, title text, location text, start_date date, start_date_precision text, end_date date, end_date_precision text, job_responsibilities text, candidate_confirmed boolean default true, staff_blocked_at timestamptz);
create table education_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, resume_document_id uuid, position int, heading text, institution text, degree text, field_of_study text, location text, start_date date, start_date_precision text, end_date date, end_date_precision text, candidate_confirmed boolean default true, staff_blocked_at timestamptz);
create table certification_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, resume_document_id uuid, position int, heading text, name text, issuing_body text, license_number text, issue_date date, issue_date_precision text, candidate_confirmed boolean default true, staff_blocked_at timestamptz);
create table verification_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, type text, source_item_id uuid, status text, status_changed_at timestamptz default now());
create table license_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, linked_certification_id uuid, state text, queue_item_id uuid, verified_at timestamptz, verification_outcome text);
create table skill_items (id uuid primary key default gen_random_uuid(), candidate_id uuid, resume_document_id uuid, position int, skill_text text, heading text, section_position int, candidate_confirmed boolean default true, staff_blocked_at timestamptz);
create table candidate_freeform_sections (id uuid primary key default gen_random_uuid(), candidate_id uuid, resume_document_id uuid, position int, section_type text, heading text, content text, candidate_confirmed boolean default true, staff_blocked_at timestamptz);
create table candidate_summary_versions (id uuid primary key default gen_random_uuid(), candidate_id uuid, partner_key text default '', created_at timestamptz default now(), content text, candidate_edited boolean default false);
create table work_overlap_holds (id uuid primary key default gen_random_uuid(), candidate_id uuid, resolved_at timestamptz);
create table work_overlap_pairs (id uuid primary key default gen_random_uuid(), hold_id uuid, item_a_id uuid, item_b_id uuid, overlap_days int);
`;
const C1 = "11111111-1111-4111-8111-111111111111", D1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const W = ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003", "a0000000-0000-4000-8000-000000000004"];
const E = ["e0000000-0000-4000-8000-000000000001", "e0000000-0000-4000-8000-000000000002"];
const K = ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002"];
async function fresh(fnText = FN) {
  const db = new PGlite(); await db.exec(SCHEMA); await db.exec(HELPERS); await db.exec(fnText);
  await db.exec(`insert into candidates (id, first_name, last_name, email, account_type, tier) values ('${C1}', 'Test', 'Person', 'p@example.test', 'full_resume', 'free');
    insert into resume_documents (id, candidate_id, confirmed_at) values ('${D1}', '${C1}', now());
    insert into work_history_items (id, candidate_id, resume_document_id, position, company, title, start_date, start_date_precision, end_date, end_date_precision) values
      ('${W[0]}', '${C1}', '${D1}', 1, 'Acme Co', 'Work One', '2018-01-01', 'year', '2020-01-01', 'year'),
      ('${W[1]}', '${C1}', '${D1}', 2, 'Beta Co', 'Work Two', '2019-01-01', 'year', '2021-01-01', 'year'),
      ('${W[2]}', '${C1}', '${D1}', 3, 'Gamma Co', 'Work Three', '2010-01-01', 'year', '2012-01-01', 'year'),
      ('${W[3]}', '${C1}', '${D1}', 4, 'Gamma Co', 'Work Four', '2010-06-01', 'month', '2011-06-01', 'month');
    insert into education_items (id, candidate_id, resume_document_id, position, institution, degree) values ('${E[0]}', '${C1}', '${D1}', 1, 'State University', 'Edu One'), ('${E[1]}', '${C1}', '${D1}', 2, 'City College', 'Edu Two');
    insert into certification_items (id, candidate_id, resume_document_id, position, name, issuing_body) values ('${K[0]}', '${C1}', '${D1}', 1, 'Cert One', 'Board A'), ('${K[1]}', '${C1}', '${D1}', 2, 'Cert Two', 'Board B');
    insert into verification_items (candidate_id, type, source_item_id, status) values ('${C1}', 'Job Experience', '${W[0]}', 'Confirmed'), ('${C1}', 'Education', '${E[0]}', 'Confirmed'), ('${C1}', 'Certification', '${K[0]}', 'Confirmed');`);
  return db;
}
// the three ways the function is called: employer document (overrides ignored, delivered only), the candidate's PDF / default view (delivered only), the Content Manager (everything)
const MODES = [[true, true, "employer comparison document"], [false, true, "PDF"], [false, false, "Content Manager"], [true, false, "plain, nothing hidden"]];
const ids = async (db, ign, del) => { const r = await db.query("select assemble_customized_resume($1, $2, $3) as r", [C1, ign, del]); const j = r.rows[0].r; return { work: j.work.map((x) => x.id), education: j.education.map((x) => x.id), certifications: j.certifications.map((x) => x.id), json: j }; };
const setBlock = (db, table, id, on) => db.exec(`update ${table} set staff_blocked_at = ${on ? "now()" : "null"} where id = '${id}'`);

t("A1 a staff blocked work, education or certification item is out of the employer comparison document, the PDF and the Content Manager (and its verification block with it); it returns once the block is cleared; the other items stay", async () => {
  const db = await fresh();
  for (const [table, id, key, others] of [["work_history_items", W[0], "work", [W[1], W[2], W[3]]], ["education_items", E[0], "education", [E[1]]], ["certification_items", K[0], "certifications", [K[1]]]]) {
    for (const [ign, del, label] of MODES) { const base = await ids(db, ign, del); assert.ok(base[key].includes(id), `${label}: ${key} item present before the block`); }
    await setBlock(db, table, id, true);
    for (const [ign, del, label] of MODES) { const r = await ids(db, ign, del); assert.equal(r[key].includes(id), false, `${label}: blocked ${key} item is gone`); for (const o of others) assert.ok(r[key].includes(o), `${label}: the others stay (${key})`); assert.equal(JSON.stringify(r.json).includes(id), false, `${label}: nothing about the blocked item is left anywhere in the answer`); }
    await setBlock(db, table, id, false);
    for (const [ign, del, label] of MODES) assert.ok((await ids(db, ign, del))[key].includes(id), `${label}: back after the block is cleared (${key})`);
  }
  await db.close();
});

const mutate = (src, from, to) => { assert.ok(src.includes(from), "plant target exists: " + from); return src.replace(from, to); };
t("A1 planted: a function with the block test removed from work, from education or from certifications lets the blocked item through (each is caught)", async () => {
  for (const [from, table, id, key] of [["w.candidate_id = p_candidate and w.candidate_confirmed and w.resume_document_id = any (v_docs) and w.staff_blocked_at is null", "work_history_items", W[0], "work"], ["e.candidate_id = p_candidate and e.candidate_confirmed and e.resume_document_id = any (v_docs) and e.staff_blocked_at is null", "education_items", E[0], "education"], ["ce.candidate_id = p_candidate and ce.candidate_confirmed and ce.resume_document_id = any (v_docs) and ce.staff_blocked_at is null", "certification_items", K[0], "certifications"]]) {
    const db = await fresh(mutate(FN, from, from.replace(" and " + from.split(" and ").pop(), "")));
    await setBlock(db, table, id, true);
    assert.equal((await ids(db, true, true))[key].includes(id), true, `planted (${key}): the blocked item leaks, so test A1 would fail`);
    await db.close();
  }
});

t("A2 two work items in an unresolved overlap hold are BOTH out of the employer document, the PDF and the Content Manager; they return when the hold is resolved; items of other pairs and education and certifications stay", async () => {
  const db = await fresh();
  await db.exec(`insert into work_overlap_holds (id, candidate_id) values ('b0000000-0000-4000-8000-000000000001', '${C1}'); insert into work_overlap_pairs (hold_id, item_a_id, item_b_id, overlap_days) values ('b0000000-0000-4000-8000-000000000001', '${W[0]}', '${W[1]}', 365);`);
  for (const [ign, del, label] of MODES) { const r = await ids(db, ign, del); assert.equal(r.work.includes(W[0]), false, label + ": job A held"); assert.equal(r.work.includes(W[1]), false, label + ": job B held"); assert.deepEqual(r.work.sort(), [W[2], W[3]].sort(), label + ": the other jobs stay"); assert.equal(r.education.length, 2); assert.equal(r.certifications.length, 2); }
  await db.exec(`update work_overlap_holds set resolved_at = now() where id = 'b0000000-0000-4000-8000-000000000001'`);
  for (const [ign, del, label] of MODES) { const r = await ids(db, ign, del); assert.ok(r.work.includes(W[0]) && r.work.includes(W[1]), label + ": both return once the hold is resolved"); }
  await db.close();
  // planted: the hold test removed from the function lets both jobs through
  const from = FN.slice(FN.indexOf("      and not exists (\n        select 1 from work_overlap_pairs p"), FN.indexOf("      and (not p_delivered_only or coalesce(o.included, true))\n  ) x;\n\n  -- ---- education"));
  assert.ok(from.includes("work_overlap_holds"), "plant target found");
  const bad = await fresh(FN.replace(from, ""));
  await bad.exec(`insert into work_overlap_holds (id, candidate_id) values ('b0000000-0000-4000-8000-000000000001', '${C1}'); insert into work_overlap_pairs (hold_id, item_a_id, item_b_id, overlap_days) values ('b0000000-0000-4000-8000-000000000001', '${W[0]}', '${W[1]}', 365);`);
  const r = await ids(bad, true, true); assert.ok(r.work.includes(W[0]) && r.work.includes(W[1]), "planted: both held jobs leak, so test A2 would fail"); await bad.close();
});

// the detection rule decides what becomes a hold; the real detectWorkOverlaps is cut out of confirm-resume-data
const CRD = rd("supabase/functions/confirm-resume-data/index.ts");
const detect = (() => { const s = CRD.indexOf("type OverlapItem"), e = CRD.indexOf("\n}\n", CRD.indexOf("function detectWorkOverlaps")) + 3; return new Function(stripTypeScriptTypes(CRD.slice(s, e)) + "\nreturn detectWorkOverlaps;")(); })();
t("A3 same company pairs are never held: the real detection flags the two different company jobs that overlap and not the two jobs of one company, so only the first pair becomes a hold and the same company jobs stay on every document", async () => {
  const items = [W[0], W[1], W[2], W[3]].map((id, i) => ({ id, company: ["Acme Co", "Beta Co", "Gamma Co", "Gamma Co"][i], start: ["2018-01-01", "2019-06-01", "2010-01-01", "2010-06-01"][i], end: ["2020-12-01", "2021-12-01", "2012-01-01", "2011-06-01"][i], startPrecision: "day", endPrecision: "day" }));
  const pairs = detect(items);
  assert.deepEqual(pairs.map((p) => [p.a, p.b]), [[W[0], W[1]]], "only the different company pair is flagged; Gamma Co with Gamma Co (overlapping months) is exempt");
  const db = await fresh();
  const hold = (await db.query(`insert into work_overlap_holds (candidate_id) values ('${C1}') returning id`)).rows[0].id;
  for (const p of pairs) await db.query("insert into work_overlap_pairs (hold_id, item_a_id, item_b_id, overlap_days) values ($1, $2, $3, $4)", [hold, p.a, p.b, p.days]);
  for (const [ign, del, label] of MODES) { const r = await ids(db, ign, del); assert.deepEqual(r.work.sort(), [W[2], W[3]].sort(), label + ": the held pair is out, both Gamma Co jobs are in"); }
  await db.close();
  // planted: a detection without the company exemption would hold the Gamma pair as well (caught)
  const noEx = new Function(stripTypeScriptTypes(CRD.slice(CRD.indexOf("type OverlapItem"), CRD.indexOf("\n}\n", CRD.indexOf("function detectWorkOverlaps")) + 3)).replace("if (overlapCompanyKey(a.company) && overlapCompanyKey(a.company) === overlapCompanyKey(b.company)) continue;", "") + "\nreturn detectWorkOverlaps;")();
  assert.equal(noEx(items).length, 2, "planted: without the exemption the same company pair is flagged too, which test A3 would reject");
});

// ================================================================== B. the edge assembler (verification view and coverage counts)
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test" })[k] } };
let DB;
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function rowMatches(row, params) {
  for (const [k, v0] of params) {
    if (["select", "limit", "order"].includes(k)) continue;
    let v = v0, neg = false; if (v.startsWith("not.")) { neg = true; v = v.slice(4); }
    const m = /^(eq|is|in)\.(.*)$/s.exec(v); if (!m) continue; const [, op, val] = m, cell = row[k]; let hit;
    if (op === "eq") hit = cell !== null && cell !== undefined && String(cell) === val;
    else if (op === "is") hit = val === "null" ? (cell === null || cell === undefined) : String(cell) === val;
    else hit = val.replace(/^\(|\)$/g, "").split(",").map(decodeURIComponent).includes(String(cell));
    if (neg ? hit : !hit) return false;
  }
  return true;
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
  if (u.host !== "db.test" || !tb) return ok({}, 404);
  return ok((DB[tb[1]] || []).filter((r) => rowMatches(r, u.searchParams)));
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "block-hold-")); let nn = 0;
async function load(source) {
  const src = source.replace(/\r\n/g, "\n").replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n")
    .replace(/from "\.\.\/_shared\/resume-atid\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-atid.ts", repo).href}"`).replace(/from "\.\.\/_shared\/resume-heading-line\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-heading-line.ts", repo).href}"`);
  const file = path.join(TMP, `ccr-${++nn}.ts`); fs.writeFileSync(file, src); return (await import(pathToFileURL(file).href)).default.fetch;
}
const CCR = rd("supabase/functions/candidate-comparison-requests/index.ts");
const seedEdge = () => ({
  candidates: [{ id: C1, first_name: "Test", last_name: "Person", account_type: "full_resume", deletion_scheduled_at: null }],
  resume_documents: [{ id: D1, candidate_id: C1, confirmed_at: "2026-10-01T00:00:00Z" }],
  work_history_items: [W[0], W[1], W[2]].map((id, i) => ({ id, candidate_id: C1, candidate_confirmed: true, resume_document_id: D1, staff_blocked_at: null, company: ["Acme Co", "Beta Co", "Gamma Co"][i], title: ["Work One", "Work Two", "Work Three"][i], location: null, start_date: "2018-01-01", start_date_precision: "year", end_date: "2020-01-01", end_date_precision: "year", position: i + 1 })),
  education_items: E.map((id, i) => ({ id, candidate_id: C1, candidate_confirmed: true, resume_document_id: D1, staff_blocked_at: null, institution: ["State University", "City College"][i], degree: ["Edu One", "Edu Two"][i], position: i + 1 })),
  certification_items: K.map((id, i) => ({ id, candidate_id: C1, candidate_confirmed: true, resume_document_id: D1, staff_blocked_at: null, name: ["Cert One", "Cert Two"][i], issuing_body: "Board", position: i + 1 })),
  verification_items: [["Job Experience", W[0]], ["Job Experience", W[1]], ["Education", E[0]], ["Certification", K[0]]].map(([type, src]) => ({ id: "v-" + src, candidate_id: C1, type, source_item_id: src, status: "Confirmed", status_changed_at: "2026-10-02T00:00:00Z" })),
  license_items: [], work_overlap_holds: [], work_overlap_pairs: [],
});
const live = async (f) => { const r = await f(new Request("http://x/", { method: "POST", headers: { Authorization: "Bearer " + SRK, "Content-Type": "application/json" }, body: JSON.stringify({ action: "assemble_live", candidate_id: C1 }) })); assert.equal(r.status, 200); return (await r.json()).content; };
const titles = (c) => ({ work: c.work.map((x) => x.title).sort(), education: c.education.map((x) => x.degree).sort(), certifications: c.certifications.map((x) => x.name).sort() });

t("B1 the employer's verification view and coverage counts: a staff blocked work, education or certification item is out of the view AND out of the counts (total and verified), and back after the block is cleared", async () => {
  const f = await load(CCR);
  DB = seedEdge(); let c = await live(f);
  assert.deepEqual(titles(c).work, ["Work One", "Work Three", "Work Two"]); assert.equal(c.coverage.work.total, 3); assert.equal(c.coverage.work.verified, 2); assert.equal(c.coverage.education.total, 2); assert.equal(c.coverage.education.verified, 1); assert.equal(c.coverage.certifications.total, 2); assert.equal(c.coverage.certifications.verified, 1);
  DB.work_history_items[0].staff_blocked_at = "2026-10-03T00:00:00Z"; DB.education_items[0].staff_blocked_at = "2026-10-03T00:00:00Z"; DB.certification_items[0].staff_blocked_at = "2026-10-03T00:00:00Z";
  c = await live(f);
  assert.deepEqual(titles(c), { work: ["Work Three", "Work Two"], education: ["Edu Two"], certifications: ["Cert Two"] });
  assert.deepEqual([c.coverage.work.total, c.coverage.work.verified, c.coverage.education.total, c.coverage.education.verified, c.coverage.certifications.total, c.coverage.certifications.verified], [2, 1, 1, 0, 1, 0], "the blocked (and verified) items are not counted: total and verified both drop");
  assert.equal(JSON.stringify(c).includes("Work One") || JSON.stringify(c).includes("Edu One") || JSON.stringify(c).includes("Cert One"), false, "nothing about a blocked item is anywhere in the answer");
  DB.work_history_items[0].staff_blocked_at = null; DB.education_items[0].staff_blocked_at = null; DB.certification_items[0].staff_blocked_at = null;
  c = await live(f); assert.deepEqual(titles(c).work, ["Work One", "Work Three", "Work Two"]); assert.equal(c.coverage.work.verified, 2);
  // planted: the block filter removed from the item queries lets blocked items (and their counts) through
  const bad = await load(mutate(CCR, "&resume_document_id=in.(${docList})&staff_blocked_at=is.null`;", "&resume_document_id=in.(${docList})`;"));
  DB = seedEdge(); DB.work_history_items[0].staff_blocked_at = "x"; DB.education_items[0].staff_blocked_at = "x"; DB.certification_items[0].staff_blocked_at = "x"; const leaked = await live(bad);
  assert.ok(titles(leaked).work.includes("Work One") && titles(leaked).education.includes("Edu One") && titles(leaked).certifications.includes("Cert One") && leaked.coverage.work.total === 3, "planted: the blocked items and their counts leak, so test B1 would fail");
});

t("B2 the employer's verification view and coverage counts with an overlap hold: BOTH jobs of a held pair are out of the view and out of the counts, other jobs stay, an RESOLVED hold changes nothing, and the unheld jobs still count as before", async () => {
  const f = await load(CCR);
  DB = seedEdge(); DB.work_overlap_holds = [{ id: "h1", candidate_id: C1, resolved_at: null }]; DB.work_overlap_pairs = [{ hold_id: "h1", item_a_id: W[0], item_b_id: W[1] }];
  let c = await live(f); assert.deepEqual(titles(c).work, ["Work Three"]); assert.deepEqual([c.coverage.work.total, c.coverage.work.verified, c.coverage.education.total, c.coverage.certifications.total], [1, 0, 2, 2], "both held jobs (one verified, one verified) are out of the counts; education and certifications are untouched");
  assert.equal(JSON.stringify(c).includes("Work One") || JSON.stringify(c).includes("Work Two"), false);
  DB.work_overlap_holds[0].resolved_at = "2026-10-04T00:00:00Z"; c = await live(f); assert.deepEqual(titles(c).work, ["Work One", "Work Three", "Work Two"], "resolved: both return");
  DB.work_overlap_holds = [{ id: "h1", candidate_id: C1, resolved_at: null }, { id: "h2", candidate_id: "99999999-9999-4999-8999-999999999999", resolved_at: null }]; DB.work_overlap_pairs = [{ hold_id: "h2", item_a_id: W[0], item_b_id: W[1] }];
  c = await live(f); assert.deepEqual(titles(c).work, ["Work One", "Work Three", "Work Two"], "another candidate's hold changes nothing");
  // planted: the hold filter removed lets both held jobs through
  const bad = await load(mutate(CCR, "if (heldWorkIds.size) work = work.filter((w) => !heldWorkIds.has(w.id));", ""));
  DB = seedEdge(); DB.work_overlap_holds = [{ id: "h1", candidate_id: C1, resolved_at: null }]; DB.work_overlap_pairs = [{ hold_id: "h1", item_a_id: W[0], item_b_id: W[1] }]; const leaked = await live(bad);
  assert.deepEqual(titles(leaked).work, ["Work One", "Work Three", "Work Two"], "planted: the held jobs leak, so test B2 would fail"); assert.equal(leaked.coverage.work.total, 3);
  // planted: a hold that is checked only for item_a leaves the partner job in
  const half = await load(mutate(CCR, "heldWorkIds = new Set(heldPairs.flatMap((p) => [p.item_a_id as string, p.item_b_id as string]));", "heldWorkIds = new Set(heldPairs.flatMap((p) => [p.item_a_id as string]));"));
  DB = seedEdge(); DB.work_overlap_holds = [{ id: "h1", candidate_id: C1, resolved_at: null }]; DB.work_overlap_pairs = [{ hold_id: "h1", item_a_id: W[0], item_b_id: W[1] }];
  assert.ok(titles(await live(half)).work.includes("Work Two"), "planted: only one job of the pair is held, so test B2 would fail");
});

t("B3 what the counts do (quoted from the code) and the employer view still shows the live statuses of everything that is NOT blocked or held: verified items count as verified, the rest as not yet checked", async () => {
  const f = await load(CCR); DB = seedEdge(); const c = await live(f);
  assert.match(CCR, /const tally = \(counts: ReturnType<typeof emptyStatusCounts>, status: ExternalStatus\) => \{\n    counts\.total\+\+;/, "tally is called once per item that remains after the filters");
  assert.match(CCR, /const workOut = work\.map\(/); assert.ok(CCR.indexOf("if (heldWorkIds.size) work = work.filter") < CCR.indexOf("const workCounts = emptyStatusCounts();"), "the hold filter runs BEFORE the counts are tallied");
  assert.ok(CCR.indexOf("&staff_blocked_at=is.null") < CCR.indexOf("const workCounts = emptyStatusCounts();"), "the block filter is in the queries that feed the counts");
  assert.equal(c.coverage.work.total, c.work.length); assert.equal(c.coverage.education.total, c.education.length); assert.equal(c.coverage.certifications.total, c.certifications.length); assert.equal(c.work.filter((w) => w.verification.status === "verified").length, c.coverage.work.verified);
});

t("C the ATID change touches none of this: the two assemblers' block and hold lines are unchanged against the base commit of this build", async () => {
  const { execFileSync } = await import("node:child_process");
  const base = execFileSync("git", ["show", (process.env.BI_BASE || "cbb33f5") + ":supabase/functions/candidate-comparison-requests/index.ts"], { cwd: repo, maxBuffer: 1 << 28 }).toString().replace(/\r\n/g, "\n");
  for (const needle of ["&resume_document_id=in.(${docList})&staff_blocked_at=is.null`;", "if (heldWorkIds.size) work = work.filter((w) => !heldWorkIds.has(w.id));", "heldWorkIds = new Set(heldPairs.flatMap((p) => [p.item_a_id as string, p.item_b_id as string]));"]) { assert.ok(base.includes(needle) && CCR.includes(needle), needle); }
  const changed = execFileSync("git", ["diff", "--name-only", process.env.BI_BASE || "cbb33f5", "b1a44b0"], { cwd: repo }).toString().split("\n").filter((x) => x && !x.startsWith("tools/")).sort();
  assert.deepEqual(changed, ["candidate.html", "supabase/functions/candidate-comparison-requests/index.ts"], "no migration, no employer-api, no employer-comparison, no employer.html change");
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
