// node tools/resume/test-lookup-split.mjs   (no network, no model call, no live database)
// Lookup split (October 21, 2026): a comparison request must not create or show an existence lookup.
//  A. SQL on a LOCAL in-process Postgres (PGlite, from the other repository's node_modules; override with LOOKUP_SPLIT_PGLITE): the migration 20261021010000_lookup_split.sql is applied to
//     stub tables on top of the REAL previous functions (taken from 20260920040000), run twice, rolled back, with planted defects.
//  B. The real employer-api source (request_comparison_direct) against an in-memory REST stand-in, and source-level checks of the two candidate lists.
// NOT proved: the real tables (stubs with the columns that matter), PostgREST, the live data (the backfill rule is shown on built rows, the live count of 2 is a SELECT in the report),
// the real pages in a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = rd("supabase/migrations/20261021010000_lookup_split.sql"), ROLLBACK = rd("supabase/rollback/20261021010000_lookup_split_rollback.sql");
const STAGE2 = rd("supabase/migrations/20260920040000_employer_comparison_stage2.sql");
const OLD_FUNCS = STAGE2.slice(STAGE2.indexOf("create or replace function list_employer_lookups"), STAGE2.indexOf("grant execute on function cleanup_expired_employer_lookups() to service_role;") + "grant execute on function cleanup_expired_employer_lookups() to service_role;".length);

const PGLITE = process.env.LOOKUP_SPLIT_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set LOOKUP_SPLIT_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.employer_lookup_requests (
  id uuid primary key default gen_random_uuid(), token text, requester_email text not null, requester_name text, requester_company text,
  candidate_name text, candidate_email text, candidate_phone text, expires_at timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now(), used_at timestamptz, result_exists boolean, matched_candidate_id uuid, candidate_label text, claim_token_hash text);
create table public.comparison_requests (
  id uuid primary key default gen_random_uuid(), candidate_id uuid not null,
  lookup_id uuid references public.employer_lookup_requests(id) on delete set null,
  requester_email text not null, status text not null default 'pending', created_at timestamptz not null default now());
`;
const OLD = { A: "00000000-0000-4000-8000-0000000000a1", B: "00000000-0000-4000-8000-0000000000b2", C: "00000000-0000-4000-8000-0000000000c3", D: "00000000-0000-4000-8000-0000000000d4", E: "00000000-0000-4000-8000-0000000000e5", F: "00000000-0000-4000-8000-0000000000f6" };
const CAND1 = "11111111-1111-4111-8111-111111111111", CAND2 = "22222222-2222-4222-8222-222222222222";
const EM = "boss@corp.test";
// Seed, BEFORE the migration (the column does not exist yet):
//  A  staged by a comparison request: request created 0.4 s after the row was used          -> must be marked
//  B  a REAL lookup that led to a request 3 minutes later (the older lookup-first path)      -> must NOT be marked
//  C  a real lookup, no request                                                              -> not marked
//  D  staged row of a request created 4.9 s later (inside the 5 second window)               -> marked
//  E  a pointed row whose request came 6 s after (outside the window)                        -> not marked
//  F  an old row (40 days) already scrubbed of its candidate, pointed to by an open request  -> cleanup must keep it
async function fresh({ migrate = true } = {}) {
  const db = new PGlite();
  await db.exec(STUB); await db.exec(OLD_FUNCS);
  await db.exec(`
    insert into employer_lookup_requests (id, requester_email, requester_name, used_at, created_at, result_exists, matched_candidate_id, candidate_label) values
      ('${OLD.A}', '${EM}', 'Boss', now() - interval '1 hour', now() - interval '1 hour', true, '${CAND1}', 'Cand One'),
      ('${OLD.B}', '${EM}', 'Boss', now() - interval '1 hour', now() - interval '1 hour', true, '${CAND1}', 'Cand One Real'),
      ('${OLD.C}', '${EM}', 'Boss', now() - interval '2 hours', now() - interval '2 hours', true, '${CAND2}', 'Cand Two'),
      ('${OLD.D}', '${EM}', 'Boss', now() - interval '3 hours', now() - interval '3 hours', true, '${CAND2}', 'Cand Two Staged'),
      ('${OLD.E}', '${EM}', 'Boss', now() - interval '4 hours', now() - interval '4 hours', true, '${CAND2}', 'Cand Two Late'),
      ('${OLD.F}', '${EM}', 'Boss', now() - interval '40 days', now() - interval '40 days', true, null, null);
    insert into comparison_requests (candidate_id, lookup_id, requester_email, status, created_at) values
      ('${CAND1}', '${OLD.A}', '${EM}', 'approved', (select used_at + interval '0.4 seconds' from employer_lookup_requests where id = '${OLD.A}')),
      ('${CAND1}', '${OLD.B}', '${EM}', 'pending',  (select used_at + interval '3 minutes' from employer_lookup_requests where id = '${OLD.B}')),
      ('${CAND2}', '${OLD.D}', '${EM}', 'pending',  (select used_at + interval '4.9 seconds' from employer_lookup_requests where id = '${OLD.D}')),
      ('${CAND2}', '${OLD.E}', '${EM}', 'pending',  (select used_at + interval '6 seconds' from employer_lookup_requests where id = '${OLD.E}')),
      ('${CAND1}', '${OLD.F}', '${EM}', 'approved', now() - interval '39 days');`);
  if (migrate) await db.exec(MIGRATION);
  return db;
}
const q = async (db, sql, p) => (await db.query(sql, p)).rows;
const listIds = async (db) => (await q(db, "select lookup_id, open_request_status from list_employer_lookups($1)", [EM])).map((r) => r.lookup_id);
const markedIds = async (db) => (await q(db, "select id from employer_lookup_requests where created_for_request order by id")).map((r) => r.id);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t("A1 the migration applies twice with no error; the column is boolean, not null, default false; every ordinary row stays false", async () => {
  const db = await fresh(); await db.exec(MIGRATION);
  const col = (await q(db, "select data_type, is_nullable, column_default from information_schema.columns where table_name='employer_lookup_requests' and column_name='created_for_request'"))[0];
  assert.deepEqual(col, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
  const fresh2 = await q(db, "insert into employer_lookup_requests (requester_email) values ('x@y.test') returning created_for_request"); assert.equal(fresh2[0].created_for_request, false);
});
t("A2 the backfill marks exactly the rows a request created within 5 seconds of the row being used (A and D), not a real lookup that led to a request (B, E), not a lookup with no request (C), and a second run changes nothing", async () => {
  const db = await fresh();
  assert.deepEqual(await markedIds(db), [OLD.A, OLD.D].sort());
  assert.equal((await q(db, "select count(*)::int n from employer_lookup_requests where created_for_request"))[0].n, 2, "the live project's expected 2 also comes out as 2 here");
  await db.exec(MIGRATION); assert.deepEqual(await markedIds(db), [OLD.A, OLD.D].sort());
});
t("A3 list_employer_lookups never returns a marked row, still returns real lookups (with the open request's status for B), and a row staged AFTER the migration is hidden too", async () => {
  const db = await fresh(); const ids = await listIds(db);
  assert.ok(!ids.includes(OLD.A) && !ids.includes(OLD.D), "marked rows are not listed");
  for (const real of [OLD.B, OLD.C, OLD.E]) assert.ok(ids.includes(real), "real lookup listed: " + real);
  assert.ok(["pending", "approved"].includes((await q(db, "select open_request_status s from list_employer_lookups($1) where lookup_id = $2", [EM, OLD.B]))[0].s), "a real lookup still shows an open request (the lateral join picks one open request for this candidate and employer)");
  await db.query("insert into employer_lookup_requests (id, requester_email, used_at, result_exists, matched_candidate_id, candidate_label, created_for_request) values ('00000000-0000-4000-8000-0000000000aa', $1, now(), true, $2, 'New', true)", [EM, CAND1]);
  assert.ok(!(await listIds(db)).includes("00000000-0000-4000-8000-0000000000aa"));
});
t("A4 cleanup keeps a row any request still points to (and does not null that request's lookup_id), still deletes the same old unreferenced rows, still scrubs labels after 30 days", async () => {
  const db = await fresh();
  await db.query("insert into employer_lookup_requests (id, requester_email, used_at, created_at, result_exists, matched_candidate_id) values ('00000000-0000-4000-8000-0000000000bb', $1, now() - interval '40 days', now() - interval '40 days', true, null)", [EM]);
  const n = (await q(db, "select cleanup_expired_employer_lookups() n"))[0].n;
  assert.equal(n, 1, "only the unreferenced old row was deleted");
  assert.equal((await q(db, "select count(*)::int c from employer_lookup_requests where id = $1", [OLD.F]))[0].c, 1, "F kept");
  assert.equal((await q(db, "select lookup_id from comparison_requests where lookup_id = $1", [OLD.F])).length, 1, "the open request still points at F");
  assert.equal((await q(db, "select count(*)::int c from employer_lookup_requests where id = '00000000-0000-4000-8000-0000000000bb'"))[0].c, 0);
  assert.equal((await q(db, "select candidate_label from employer_lookup_requests where id = $1", [OLD.A]))[0].candidate_label, "Cand One", "a young row keeps its label");
  await db.exec(`update employer_lookup_requests set used_at = now() - interval '31 days' where id = '${OLD.A}'`); await db.exec("select cleanup_expired_employer_lookups()");
  assert.equal((await q(db, "select candidate_label from employer_lookup_requests where id = $1", [OLD.A]))[0].candidate_label, null, "the 30 day label scrub is unchanged");
});
t("A5 the previous cleanup WOULD have deleted F and nulled the request's lookup_id (the reason for the guard); the rollback restores the previous behaviour and removes the column", async () => {
  const db = await fresh({ migrate: false });
  await db.exec("select cleanup_expired_employer_lookups()");
  assert.equal((await q(db, "select count(*)::int c from employer_lookup_requests where id = $1", [OLD.F]))[0].c, 0, "old cleanup deletes F");
  assert.equal((await q(db, "select lookup_id from comparison_requests where candidate_id = $1 and status = 'approved' and created_at < now() - interval '30 days'", [CAND1]))[0].lookup_id, null, "and nulls the open request's lookup_id");
  const db2 = await fresh(); await db2.exec(ROLLBACK);
  assert.equal((await q(db2, "select count(*)::int c from information_schema.columns where table_name='employer_lookup_requests' and column_name='created_for_request'"))[0].c, 0);
  assert.ok((await listIds(db2)).includes(OLD.A), "after the rollback the list is the old list");
  await db2.exec(MIGRATION); assert.deepEqual(await markedIds(db2), [OLD.A, OLD.D].sort(), "and the migration can be applied again");
});
t("A6 planted defects are caught: a list without the marker test, a cleanup without the guard, a backfill with a 10 minute window, a backfill of every pointed row", async () => {
  const run = async (mutate, probe) => { const sql = mutate(MIGRATION); assert.notEqual(sql, MIGRATION, "the plant landed"); const db = await fresh({ migrate: false }); await db.exec(sql); return probe(db); };
  assert.equal(await run((s) => s.replace("    and l.created_for_request is not true\n", ""), async (db) => (await listIds(db)).includes(OLD.A)), true, "list plant: staged row shows");
  assert.equal(await run((s) => s.replace("   where not exists (select 1 from comparison_requests cr where cr.lookup_id = l.id)\n     and (", "   where ("), async (db) => { await db.exec("select cleanup_expired_employer_lookups()"); return (await q(db, "select count(*)::int c from employer_lookup_requests where id = $1", [OLD.F]))[0].c === 0; }), true, "cleanup plant: F deleted");
  assert.deepEqual(await run((s) => s.replace("< 5)", "< 600)"), markedIds), [OLD.A, OLD.B, OLD.D, OLD.E].sort(), "window plant marks the real lookups B and E");
  assert.deepEqual(await run((s) => s.replace("                  and l.used_at is not null\n                  and abs(extract(epoch from (cr.created_at - l.used_at))) < 5)", "                  )"), markedIds), [OLD.A, OLD.B, OLD.D, OLD.E, OLD.F].sort(), "pointed-rows plant marks every pointed row");
});

// ------------------------------------------------------------------ B. employer-api against a stand-in
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test", STRIPE_SECRET_KEY: "sk_test" })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
let DB, CALLS, REJECT_MARKER;
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const matches = (row, params) => { for (const [k, v] of params) { if (["select", "limit", "order"].includes(k)) continue; const m = /^(eq|ilike|is|gte|gt|in)\.(.*)$/s.exec(v); if (!m) continue; const [, op, val] = m, cell = row[k]; if (op === "eq" && String(cell) !== val) return false; if (op === "ilike") { const re = new RegExp("^" + val.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"); if (!re.test(String(cell ?? ""))) return false; } if (op === "is" && (val === "null" ? cell != null : cell == null)) return false; if (op === "gte" && !(String(cell) >= val)) return false; } return true; };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = (init.method || "GET").toUpperCase();
  if (u.pathname.startsWith("/functions/v1/")) { CALLS.push("FN " + u.pathname); return ok({ sent: true }); }
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(u.pathname); if (rpc) { CALLS.push("RPC " + rpc[1] + " " + (init.body || "")); return ok(DB.__rpc[rpc[1]]); }
  const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!tb) return ok({ error: "unknown" }, 404);
  const table = tb[1]; DB[table] = DB[table] || [];
  if (method === "GET") return ok(DB[table].filter((r) => matches(r, u.searchParams)));
  if (method === "POST") { const rec = JSON.parse(init.body); if (table === "employer_lookup_requests" && REJECT_MARKER && "created_for_request" in rec) { CALLS.push("POST employer_lookup_requests REJECTED"); return ok({ code: "PGRST204", message: "Could not find the 'created_for_request' column" }, 400); } const row = { id: crypto.randomUUID(), ...rec }; DB[table].push(row); CALLS.push("POST " + table + (("created_for_request" in rec) ? " marker=" + rec.created_for_request : " nomarker")); return init.headers?.Prefer?.includes("return=representation") ? ok([row], 201) : new Response(null, { status: 201 }); }
  if (method === "PATCH") { const hit = DB[table].filter((r) => matches(r, u.searchParams)); hit.forEach((r) => Object.assign(r, JSON.parse(init.body))); return init.headers?.Prefer?.includes("return=representation") ? ok(hit) : new Response(null, { status: 204 }); }
  return ok({}, 405);
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-split-"));
let n = 0;
async function load(fn, source) {
  const src = source.replace(/\r\n/g, "\n").replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n");
  const file = path.join(TMP, `${fn}-${++n}.ts`); fs.writeFileSync(file, src); return (await import(pathToFileURL(file).href)).default.fetch;
}
const API_SRC = rd("supabase/functions/employer-api/index.ts");
const SESSION = "S".repeat(40), TARGET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", DOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const seed = async (cand) => { DB = { employer_users: [{ id: "u1", email: "boss@corp.test", name: "Boss", org_id: null, role: "owner" }], employer_sessions: [{ id: "s1", employer_user_id: "u1", token_hash: await sha(SESSION), expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null }],
  employer_lookup_requests: [], candidates: [{ id: TARGET, email: "lisa@example.test", phone: null, first_name: "Lisa", last_name: "Test", full_name: "Lisa Test", discoverable: false, allow_comparison_requests: true, deletion_scheduled_at: null, account_type: "full_resume", ...cand }],
  __rpc: { create_comparison_request_direct: [{ ok: true, reason: null, detail: null, request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }] } }; CALLS = []; REJECT_MARKER = false; };
const direct = async (fnc, over = {}) => { const r = await fnc(new Request("http://x/", { method: "POST", body: JSON.stringify({ session_token: SESSION, action: "request_comparison_direct", params: { candidate_name: "Lisa Test", candidate_email: "lisa@example.test", attestation: "I got her email from her business card at the conference.", document_id: DOC, requester_company: "Corp", ...over } }) })); return { status: r.status, body: await r.json() }; };

t("B1 a comparison request SUCCEEDS for a candidate with Lookup off (discoverable false) and comparison requests on; the staged row is marked, burned, and passed to the request; the candidate is told", async () => {
  const f = await load("employer-api", API_SRC); await seed({});
  const r = await direct(f);
  assert.equal(r.status, 200); assert.equal(r.body.outcome, "sent"); assert.equal(r.body.status, "awaiting_candidate");
  assert.equal(DB.employer_lookup_requests.length, 1); const row = DB.employer_lookup_requests[0];
  assert.equal(row.created_for_request, true, "marked"); assert.equal(row.result_exists, true); assert.equal(row.matched_candidate_id, TARGET); assert.ok(row.used_at); assert.equal(row.candidate_label, "Lisa Test");
  assert.equal(row.candidate_name, null, "the typed name, email and phone are scrubbed as before");
  assert.ok(CALLS.some((c) => c.startsWith("RPC create_comparison_request_direct") && c.includes(`"p_lookup_id":"${row.id}"`)), "the row is still passed as p_lookup_id");
  assert.ok(CALLS.includes("FN /functions/v1/candidate-comparison-requests"), "the candidate is notified");
});
t("B2 the same request for a candidate who does not accept comparison requests is still not_found / not_accepting exactly as before (the marker changes no outcome), and the shared 5 per hour limit still counts marked rows", async () => {
  const f = await load("employer-api", API_SRC);
  await seed({ allow_comparison_requests: false }); assert.equal((await direct(f)).body.outcome, "not_found");
  await seed({ allow_comparison_requests: false, discoverable: true }); assert.equal((await direct(f)).body.outcome, "not_accepting");
  await seed({}); for (let i = 0; i < 5; i++) DB.employer_lookup_requests.push({ id: "00000000-0000-4000-8000-00000000000" + i, requester_email: "boss@corp.test", created_at: new Date().toISOString(), created_for_request: true });
  const lim = await direct(f); assert.equal(lim.status, 429); assert.equal(lim.body.error, "rate_limited");
});
t("B3 safe to deploy BEFORE the migration: when the database does not know the column, the insert is retried without it and the comparison request still succeeds (row unmarked until the migration backfills it)", async () => {
  const f = await load("employer-api", API_SRC); await seed({}); REJECT_MARKER = true;
  const r = await direct(f); assert.equal(r.body.outcome, "sent");
  assert.deepEqual(CALLS.filter((c) => c.startsWith("POST employer_lookup_requests")), ["POST employer_lookup_requests REJECTED", "POST employer_lookup_requests nomarker"]);
  assert.equal(DB.employer_lookup_requests[0].created_for_request, undefined);
});
t("B4 planted: an employer-api that does not set the marker, or that has no fallback, is caught by B1 / B3", async () => {
  const noMarker = API_SRC.replace("body: JSON.stringify({ ...stagedRow, created_for_request: true })", "body: JSON.stringify({ ...stagedRow })"); assert.notEqual(noMarker, API_SRC);
  await seed({}); await direct(await load("employer-api", noMarker)); assert.notEqual(DB.employer_lookup_requests[0].created_for_request, true, "planted: not marked, so B1 would fail");
  const noFallback = API_SRC.replace(/      if \(!insRes\.ok\) insRes = await rest\("employer_lookup_requests"[^\n]*\n/, ""); assert.notEqual(noFallback, API_SRC);
  await seed({}); REJECT_MARKER = true; const r = await direct(await load("employer-api", noFallback)); assert.notEqual(r.body.outcome, "sent", "planted: no fallback breaks the request, so B3 would fail");
});
t("B5 the candidate's two lists skip marked rows and fall back when the column is missing (source level: no list harness for a signed-in candidate); every other reader is unchanged", () => {
  const cmp = rd("supabase/functions/candidate-comparison-requests/index.ts"), act = rd("supabase/functions/list-candidate-activity/index.ts");
  assert.match(cmp, /tier1: tier1\.filter\(\(t\) => t\.created_for_request !== true && !reqs\.some\(\(r\) => r\.lookup_id === t\.id\)\)/);
  assert.match(cmp, /select=id,requester_email,requester_company,used_at,created_for_request&order=used_at\.desc&limit=100`\)\s*\n\s*\.catch\(\(\) => rows\(`employer_lookup_requests\?matched_candidate_id=eq\.\$\{candidateId\}&result_exists=eq\.true&select=id,requester_email,requester_company,used_at&order/);
  assert.match(act, /const lookups = allLookups\.filter\(\(l\) => !linkedLookupIds\.has\(l\.id\) && l\.created_for_request !== true\);/);
  assert.match(act, /select=id,used_at,requester_email,requester_company,created_for_request&order=used_at\.desc&limit=200`\)\s*\n\s*\.catch\(\(\) => rest\(/);
  // planted: removing the marker test from either list is noticed
  assert.equal(/t\.created_for_request !== true/.test(cmp.replace("t.created_for_request !== true && ", "")), false); assert.equal(/l\.created_for_request !== true/.test(act.replace(" && l.created_for_request !== true", "")), false);
  // unchanged readers: the rate limits and label readers do not mention the marker
  for (const f of ["check-existence", "send-lookup-confirmation", "employer-comparison", "employer-document"]) assert.equal(/created_for_request/.test(rd(`supabase/functions/${f}/index.ts`)), false, f);
  assert.equal([...rd("supabase/functions/employer-api/index.ts").matchAll(/created_for_request/g)].length >= 2, true);
  // the employer page reads the list only through list_lookups (the SQL function), so it needs no change
  assert.equal(/created_for_request/.test(rd("employer.html")), false); assert.match(rd("supabase/functions/employer-api/index.ts"), /rest\("rpc\/list_employer_lookups"/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e?.stack ?? e).split("\n").slice(0, 7).join("\n       ")); } }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* left */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
