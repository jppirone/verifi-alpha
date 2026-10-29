// node tools/resume/test-open-by-reminders.mjs   (no network, no model call, no live database, NO REAL EMAIL: the mail service is a stand-in inside this process)
// BS (October 23, 2026): open-by reminder emails for approved but unopened pay per use comparisons.
//  A. SQL on a LOCAL in-process Postgres (PGlite, from the other repository's node_modules; override with LOOKUP_SPLIT_PGLITE): the real migration file 20261023010000_open_by_reminders.sql on a stub
//     comparison_requests table, with planted defects, each shown caught.
//  B. The real candidate-comparison-requests source (the sweep) against an in-memory REST stand-in and a stand-in mail service, with planted defects, each shown caught.
// NOT proved: the real table, PostgREST, a real email arriving, the mail service accepting the no reply address, a real sweep run, true parallel sessions (one connection here).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const git = (...a) => execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28 }).toString().replace(/\r\n/g, "\n");
const BASE = process.env.BS_BASE || "c7ff604";
const MIGRATION = rd("supabase/migrations/20261023010000_open_by_reminders.sql"), ROLLBACK = rd("supabase/rollback/20261023010000_open_by_reminders_rollback.sql");
const CCR = rd("supabase/functions/candidate-comparison-requests/index.ts");
const tests = []; const t = (name, fn) => tests.push([name, fn]);
const mutate = (src, from, to) => { assert.ok(src.includes(from), "the planted change applies: " + from.slice(0, 60)); return src.replace(from, to); };
const mutateRe = (src, re, to) => { const out = src.replace(re, to); assert.notEqual(out, src, "the planted change applies: " + re); return out; };
const EM = String.fromCharCode(0x2014), DASH2 = String.fromCharCode(32, 45, 45, 32);

const PGLITE = process.env.LOOKUP_SPLIT_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set LOOKUP_SPLIT_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);

// ====================================================================== A. SQL
const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.comparison_requests (
  id uuid primary key default gen_random_uuid(), status text not null default 'approved', access_method text not null default 'guest',
  employer_user_id uuid, requester_email text not null default 'x@corp.test', requester_name text, kind text not null default 'resume_comparison',
  first_delivered_at timestamptz, snapshot_expires_at timestamptz, closed_at timestamptz);
`;
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
// one row; o.left = a SQL interval text such as "48 hours" (negative allowed), null for no deadline. Used only after the migration (it names the two new columns).
const ins = (o = {}) => {
  const q = (v) => (v === null || v === undefined ? "null" : "'" + String(v).replace(/'/g, "''") + "'");
  const d = Object.assign({ st: "approved", am: "guest", eu: U1, fd: false, left: "36 hours", r2d: false, rld: false, name: "Pat Example", email: "pat@corp.test", kind: "resume_comparison" }, o);
  return `insert into public.comparison_requests (status, access_method, employer_user_id, requester_email, requester_name, kind, first_delivered_at, snapshot_expires_at, reminder_2d_sent_at, reminder_last_day_sent_at)
    values (${q(d.st)}, ${q(d.am)}, ${q(d.eu)}, ${q(d.email)}, ${q(d.name)}, ${q(d.kind)}, ${d.fd ? "now()" : "null"}, ${d.left === null ? "null" : "now() + interval '" + d.left + "'"}, ${d.r2d ? "now()" : "null"}, ${d.rld ? "now()" : "null"});\n`;
};
async function freshDb(migration) { const db = new PGlite(); await db.exec(STUB); await db.exec(migration); return db; }
// run a scenario inside ONE transaction (now() is constant inside it, so exact boundaries are exact), then roll it back
async function scenario(db, fn) {
  await db.exec("begin");
  try { return await fn({ exec: (s) => db.exec(s), q: async (s) => (await db.query(s)).rows }); } finally { await db.exec("rollback"); }
}
const CALL = (limit = "20", peek = "false", only = "null") => `select * from public.claim_open_by_reminders(${limit}, ${peek}, ${only})`;
const MARKED = "select count(*)::int n from public.comparison_requests where reminder_2d_sent_at is not null or reminder_last_day_sent_at is not null";

// All the SQL checks; returns the list of failed checks (empty = all good). A planted migration must make this list non-empty.
async function sqlChecks(migration) {
  const db = await freshDb(migration); const bad = []; const ck = (label, ok) => { if (!ok) bad.push(label); };
  const run = async (label, fn) => { try { await scenario(db, fn); } catch (e) { bad.push(label + " threw: " + String(e.message || e).slice(0, 80)); } };

  await run("excluded states", async (s) => {
    await s.exec([ins({ st: "pending" }), ins({ st: "declined" }), ins({ st: "expired" }), ins({ am: "org" }), ins({ eu: null }), ins({ fd: true }), ins({ left: "-1 second" }), ins({ left: "0 seconds" }), ins({ left: null })].join(""));
    ck("excluded states: nothing handed out", (await s.q(CALL())).length === 0);
    ck("excluded states: nothing marked", (await s.q(MARKED))[0].n === 0);
  });
  for (const [left, want] of [["48 hours 1 second", null], ["48 hours", "2d"], ["36 hours", "2d"], ["24 hours 1 second", "2d"], ["24 hours", "last_day"], ["12 hours", "last_day"], ["1 second", "last_day"], ["0 seconds", null], ["-1 second", null]]) {
    await run("boundary " + left, async (s) => {
      await s.exec(ins({ left }));
      const r = await s.q(CALL()); ck(`boundary ${left}: ${want || "nothing"}`, want === null ? r.length === 0 : r.length === 1 && r[0].which === want);
    });
  }
  await run("kinds", async (s) => { await s.exec(ins({ kind: "license_report", left: "30 hours" }) + ins({ left: "30 hours" })); ck("both kinds are included", (await s.q(CALL())).length === 2); });
  await run("first seen with 10 hours left", async (s) => {
    await s.exec(ins({ left: "10 hours" }));
    const r1 = await s.q(CALL()); ck("10 hours left: only last_day", r1.length === 1 && r1[0].which === "last_day");
    await s.exec("update public.comparison_requests set snapshot_expires_at = now() + interval '40 hours'");
    ck("10 hours left: never a 2d later, even if the deadline moved out again", (await s.q(CALL())).length === 0);
    const m = (await s.q("select reminder_2d_sent_at, reminder_last_day_sent_at from public.comparison_requests"))[0]; ck("10 hours left: only the last day column is set", m.reminder_2d_sent_at === null && m.reminder_last_day_sent_at !== null);
  });
  await run("2d then last_day, each once", async (s) => {
    await s.exec(ins({ left: "40 hours" }));
    const a = await s.q(CALL()); ck("2d handed out", a.length === 1 && a[0].which === "2d");
    ck("2d not again (idempotent second and third run)", (await s.q(CALL())).length === 0 && (await s.q(CALL())).length === 0);
    await s.exec("update public.comparison_requests set snapshot_expires_at = now() + interval '12 hours'");
    const b = await s.q(CALL()); ck("last_day handed out later", b.length === 1 && b[0].which === "last_day");
    ck("last_day not again", (await s.q(CALL())).length === 0);
    const m = (await s.q("select reminder_2d_sent_at is not null a, reminder_last_day_sent_at is not null b from public.comparison_requests"))[0]; ck("both columns set once", m.a && m.b);
  });
  await run("2d recorded earlier then 12 hours left", async (s) => { await s.exec(ins({ left: "12 hours", r2d: true })); const r = await s.q(CALL()); ck("last_day still goes out after an earlier 2d", r.length === 1 && r[0].which === "last_day"); });
  await run("peek", async (s) => {
    await s.exec(ins({ left: "30 hours" }) + ins({ left: "5 hours" }));
    const p = await s.q(CALL("20", "true")); ck("peek returns the rows", p.length === 2);
    ck("peek marks nothing", (await s.q(MARKED))[0].n === 0);
    ck("peek twice is the same", (await s.q(CALL("20", "true"))).length === 2);
    ck("a real call after peeks still hands both out", (await s.q(CALL())).length === 2);
  });
  await run("allowlist", async (s) => {
    await s.exec(ins({ eu: U1, left: "30 hours" }) + ins({ eu: U2, left: "30 hours" }));
    const only1 = await s.q(CALL("20", "false", `array['${U1}']::uuid[]`)); ck("allowlist: only the listed user", only1.length === 1);
    ck("allowlist: the other user is not marked", (await s.q(`select count(*)::int n from public.comparison_requests where employer_user_id = '${U2}' and reminder_2d_sent_at is not null`))[0].n === 0);
    ck("allowlist: an empty list means nobody", (await s.q(CALL("20", "false", "array[]::uuid[]"))).length === 0);
    ck("allowlist: null means everyone (the rest)", (await s.q(CALL("20", "false", "null"))).length === 1);
  });
  await run("limit", async (s) => {
    await s.exec([ins({ left: "30 hours" }), ins({ left: "31 hours" }), ins({ left: "32 hours" }), ins({ left: "33 hours" }), ins({ left: "34 hours" })].join(""));
    const r = await s.q(CALL("2")); ck("limit 2 hands out 2", r.length === 2);
    ck("limit: the rest stay unmarked", (await s.q("select count(*)::int n from public.comparison_requests where reminder_2d_sent_at is null"))[0].n === 3);
    ck("limit 0 hands out nothing", (await s.q(CALL("0"))).length === 0);
  });
  await run("returned columns", async (s) => {
    await s.exec(ins({ left: "30 hours" })); const r = await s.q(CALL("20", "true"));
    ck("returned columns are exactly the five", JSON.stringify(Object.keys(r[0]).sort()) === JSON.stringify(["id", "requester_email", "requester_name", "snapshot_expires_at", "which"]));
  });
  const meta = (await db.query("select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p where p.proname = 'claim_open_by_reminders'")).rows[0];
  ck("security definer with a fixed search_path", !!meta && meta.prosecdef === true && JSON.stringify(meta.proconfig || []).includes("search_path"));
  ck("execute: not anon, not authenticated, yes service_role", !!meta && meta.a === false && meta.u === false && meta.s === true);
  await db.close();
  return bad;
}
t("A1 the claim function: states, boundaries, first seen late, 2d then last_day, idempotent, peek, allowlist, limit, columns, privileges", async () => { assert.deepEqual(await sqlChecks(MIGRATION), []); });
const SQL_MUT = [
  ["status filter removed", /r\.status = 'approved'/g, "true"],
  ["pay per use filter removed", /and r\.access_method = 'guest'/g, ""],
  ["employer account filter removed", /and r\.employer_user_id is not null/g, ""],
  ["opened filter removed", /and r\.first_delivered_at is null/g, ""],
  ["past deadlines allowed", /and r\.snapshot_expires_at > now\(\)/g, ""],
  ["48 hour edge moved", /<= interval '48 hours'/g, "< interval '48 hours'"],
  ["24 hour edge moved", /now\(\) <= interval '24 hours' then/g, "now() < interval '24 hours' then"],
  ["2d resent (its own column ignored)", /and r\.reminder_2d_sent_at is null and /g, "and "],
  ["last day resent (its own column ignored)", /<= interval '24 hours' and r\.reminder_last_day_sent_at is null\)/g, "<= interval '24 hours')"],
  ["2d allowed after a last day reminder", /and r\.reminder_2d_sent_at is null and r\.reminder_last_day_sent_at is null\)/g, "and r.reminder_2d_sent_at is null)"],
  ["peek marks (the peek branch disabled)", /if coalesce\(p_peek, false\) then/, "if false then"],
  ["allowlist ignored", /and \(p_only_employer_user_ids is null or r\.employer_user_id = any\(p_only_employer_user_ids\)\)/g, ""],
  ["limit ignored", /limit v_limit/g, ""],
  ["execute left open to anon", /revoke all on function public\.claim_open_by_reminders\(integer, boolean, uuid\[\]\) from public, anon, authenticated;/, ""],
];
for (const [label, re, to] of SQL_MUT) t("A2 planted bug caught: " + label, async () => {
  const bad = mutateRe(MIGRATION, re, to);
  let list; try { list = await sqlChecks(bad); } catch (e) { list = ["did not run: " + e.message]; }
  assert.ok(list.length > 0, "sqlChecks did not notice: " + label);
});
t("A3 the migration runs twice without error, is additive (nothing dropped or deleted, one new function), and the rollback removes the function and both columns", async () => {
  const db = await freshDb(MIGRATION); await db.exec(MIGRATION);
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_name = 'comparison_requests' and column_name in ('reminder_2d_sent_at', 'reminder_last_day_sent_at')")).rows[0].n, 2);
  const body = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal(/\bdrop\b|\bdelete\b|\btruncate\b/i.test(body), false, "nothing is dropped or deleted");
  assert.equal([...body.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]).join(), "claim_open_by_reminders");
  assert.equal([...body.matchAll(/alter table ([\w.]+) add column if not exists (\w+)/g)].map((m) => m[1] + "." + m[2]).join(), "public.comparison_requests.reminder_2d_sent_at,public.comparison_requests.reminder_last_day_sent_at");
  await db.exec(ROLLBACK);
  assert.equal((await db.query("select count(*)::int n from pg_proc where proname = 'claim_open_by_reminders'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_name = 'comparison_requests' and column_name like 'reminder_%'")).rows[0].n, 0);
  await db.close();
});
t("A4 static: skip locked is in the marking branch, exactly five columns are returned and no candidate id, and both files are plain ASCII with no em dash", () => {
  assert.ok(MIGRATION.includes("for update of r skip locked"));
  assert.equal(MIGRATION.includes("candidate_id"), false); assert.ok(MIGRATION.includes("returns table(id uuid, which text, requester_email text, requester_name text, snapshot_expires_at timestamptz)"));
  for (const [n, s] of [["migration", MIGRATION], ["rollback", ROLLBACK]]) { assert.equal(/[^\x00-\x7f]/.test(s), false, n); assert.equal(s.includes(EM), false, n); assert.equal(s.split("\n").some((l) => !l.trim().startsWith("--") && l.includes(DASH2)), false, n); }
});
t("A5 planted: a migration without skip locked is noticed by the static check", () => { assert.equal(mutate(MIGRATION, "for update of r skip locked", "for update of r").includes("skip locked"), false); });

// ====================================================================== B. the edge function
const ENV = { SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: "srk-test", RESEND_API_KEY: "re_test" };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
let ST;
const fresh = () => (ST = { claim: [], pricing: [{ amount_cents: 1900, currency: "usd" }], reqs: {}, owed: [], mail: "ok", mails: [], patches: [], rpc: [], order: [], logs: [] });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = (init.method || "GET").toUpperCase();
  if (u.host === "api.resend.com") { const b = JSON.parse(init.body); ST.order.push("mail"); ST.mails.push({ ...b, keys: Object.keys(b) }); if (ST.mail === "throw") throw new Error("network down"); return ST.mail === "reject" ? ok({ message: "no" }, 422) : ok({ id: "m1" }); }
  if (u.host !== "db.test") return ok({}, 404);
  const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
  if (rpc) { ST.order.push(rpc[1]); if (rpc[1] === "claim_open_by_reminders") { ST.rpc.push(JSON.parse(init.body)); return ok(JSON.parse(JSON.stringify(ST.claim))); } return ok({}); }
  const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!tb) return ok({}, 404);
  const id = (u.searchParams.get("id") || "").replace(/^eq\./, "");
  if (method === "PATCH") { ST.patches.push({ table: tb[1], id, body: JSON.parse(init.body) }); return ok(ST.reqs[id] ? [ST.reqs[id]] : []); }
  if (tb[1] === "internal_job_secrets") return ok([{ value: "sec" }]);
  if (tb[1] === "employer_pricing") return ok(ST.pricing);
  if (tb[1] === "comparison_requests") { if (id) return ok(ST.reqs[id] ? [ST.reqs[id]] : []); if (u.search.includes("status=in.(declined,expired)")) return ok(ST.owed); return ok([]); }
  return ok([]);
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "open-by-")); let nn = 0;
async function load(source) {
  const src = source.replace(/\r\n/g, "\n").replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n")
    .replace(/from "\.\.\/_shared\/resume-atid\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-atid.ts", repo).href}"`).replace(/from "\.\.\/_shared\/resume-heading-line\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-heading-line.ts", repo).href}"`);
  const file = path.join(TMP, `ccr-${++nn}.ts`); fs.writeFileSync(file, src); return (await import(pathToFileURL(file).href)).default.fetch;
}
async function sweep(f) {
  const logs = []; const real = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  let res; try { res = await f(new Request("http://x/", { method: "POST", headers: { "x-comparison-secret": "sec", "Content-Type": "application/json" }, body: JSON.stringify({ action: "sweep" }) })); } finally { console.log = real; }
  ST.logs = logs; assert.equal(res.status, 200); return res.json();
}
const ROW = (id, which, extra = {}) => ({ id, which, requester_email: "pat@corp.test", requester_name: "Pat Example", snapshot_expires_at: "2026-10-30T18:44:01.000Z", ...extra });
const open = (...ids) => { for (const id of ids) ST.reqs[id] = { id, first_delivered_at: null }; };
const setEnv = (mode, ids) => { if (mode === undefined) delete ENV.REMINDER_EMAILS; else ENV.REMINDER_EMAILS = mode; if (ids === undefined) delete ENV.REMINDER_TEST_USER_IDS; else ENV.REMINDER_TEST_USER_IDS = ids; };
const text = (html) => html.replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\n$/, "");
const FOOT = "You are receiving this email because a comparison request you made in Applitrust was approved by the candidate and has not been opened yet. These reminders stop once you open the comparison.\nIf you did not make this request, or you have a question about these emails, contact support@applitrust.com.";
const EXPECT = {
  "2d": { subject: "2 days left to open your Applitrust comparison", text: "Hi Pat Example,\nThe candidate approved your comparison request. You have until Fri, 30 Oct 2026 18:44:01 UTC to open it.\n$19.00 is charged only when you open the comparison. Nothing is charged now.\nSign in and open My comparisons: https://alpha.applitrust.com/employer.html\nIf you do not open it by then, it expires, any hold on your card is released and you are not charged.\n" + FOOT },
  last_day: { subject: "Last day to open your Applitrust comparison", text: "Hi Pat Example,\nYour approved comparison expires in less than 24 hours, at Fri, 30 Oct 2026 18:44:01 UTC.\n$19.00 is charged only when you open the comparison. Nothing is charged now.\nSign in and open My comparisons: https://alpha.applitrust.com/employer.html\nIf you do not open it by then, it expires, any hold on your card is released and you are not charged.\nThis is the last reminder about this request.\n" + FOOT },
};

// All the edge checks against one source; returns the list of failed checks.
async function edgeChecks(source) {
  const f = await load(source); const bad = []; const ck = (label, c) => { if (!c) bad.push(label); };
  const go = async (label, fn) => { fresh(); try { await fn(); } catch (e) { bad.push(label + " threw: " + String(e.message || e).slice(0, 90)); } };
  const claimed = () => ST.order.includes("claim_open_by_reminders");
  for (const v of [undefined, "off", "ON", "yes", "", "dryrun", "true"]) await go("off " + v, async () => { setEnv(v, U1); ST.claim = [ROW("r1", "2d")]; open("r1"); const r = await sweep(f);
    ck(`mode ${v}: no claim call`, !claimed()); ck(`mode ${v}: no mail`, ST.mails.length === 0); ck(`mode ${v}: no patch`, ST.patches.length === 0); ck(`mode ${v}: no log line`, !ST.logs.some((l) => l.includes("open-by reminders"))); ck(`mode ${v}: reported as off`, r.open_by_reminders.mode === "off"); });
  await go("dry", async () => { setEnv("dry"); ST.claim = [ROW("r1", "2d"), ROW("r2", "last_day"), ROW("r3", "last_day")]; const r = await sweep(f);
    ck("dry: the claim function is called in peek mode", ST.rpc.length === 1 && ST.rpc[0].p_peek === true); ck("dry: nothing sent", ST.mails.length === 0); ck("dry: nothing marked or released", ST.patches.length === 0);
    const line = ST.logs.find((l) => l.includes("open-by reminders")) || ""; ck("dry: counts logged", /two_day=1 last_day=2 sent=0/.test(line)); ck("dry: no address or name in any log line", !/@|Pat|Example|corp/.test(ST.logs.join("\n"))); ck("dry: counts in the answer", r.open_by_reminders.two_day === 1 && r.open_by_reminders.last_day === 2); });
  await go("test", async () => { setEnv("test", ` ${U1},${U2} , not-an-id, pat@corp.test `); ST.claim = [ROW("r1", "2d")]; open("r1"); await sweep(f);
    ck("test: claim asks for exactly the listed ids (bad entries dropped)", ST.rpc.length === 1 && JSON.stringify(ST.rpc[0].p_only_employer_user_ids) === JSON.stringify([U1, U2]) && ST.rpc[0].p_peek === false); ck("test: sent to the claimed", ST.mails.length === 1); });
  await go("test empty", async () => { for (const ids of [undefined, "", " , ", "not-an-id,pat@corp.test"]) { fresh(); setEnv("test", ids); ST.claim = [ROW("r1", "2d")]; open("r1"); await sweep(f); ck(`test with list ${JSON.stringify(ids)}: nobody`, !claimed() && ST.mails.length === 0); } });
  await go("on", async () => { setEnv("on"); ST.claim = [ROW("r1", "2d"), ROW("r2", "last_day")]; open("r1", "r2"); const r = await sweep(f);
    ck("on: claim for everyone, 20 at most, marking", ST.rpc.length === 1 && ST.rpc[0].p_only_employer_user_ids === null && ST.rpc[0].p_limit === 20 && ST.rpc[0].p_peek === false); ck("on: one email each", ST.mails.length === 2 && r.open_by_reminders.sent === 2);
    ck("on: the expiry step ran before the claim", ST.order.indexOf("expire_comparison_requests") >= 0 && ST.order.indexOf("expire_comparison_requests") < ST.order.indexOf("claim_open_by_reminders")); ck("on: the old answer keys are still there", ["expired", "requester_notices_sent", "candidate_notices_retried", "guest_links_sent"].every((k) => k in r)); });
  for (const [label, pricing] of [["no price row", []], ["zero amount", [{ amount_cents: 0, currency: "usd" }]], ["no amount", [{ currency: "usd" }]]]) await go("price " + label, async () => { for (const mode of ["on", "test"]) { fresh(); setEnv(mode, U1); ST.pricing = pricing; ST.claim = [ROW("r1", "2d")]; open("r1"); await sweep(f); ck(`${mode} with ${label}: no claim, no mail`, !claimed() && ST.mails.length === 0); } });
  await go("rejection releases", async () => { setEnv("on"); ST.mail = "reject"; ST.claim = [ROW("r1", "2d"), ROW("r2", "last_day")]; open("r1", "r2"); const r = await sweep(f);
    ck("rejection: each claim released, in its own column", ST.patches.length === 2 && JSON.stringify(ST.patches[0].body) === '{"reminder_2d_sent_at":null}' && JSON.stringify(ST.patches[1].body) === '{"reminder_last_day_sent_at":null}' && ST.patches[0].id === "r1" && ST.patches[1].id === "r2"); ck("rejection: counted as released", r.open_by_reminders.released === 2 && r.open_by_reminders.sent === 0); });
  await go("network error keeps", async () => { setEnv("on"); ST.mail = "throw"; ST.claim = [ROW("r1", "2d")]; open("r1"); const r = await sweep(f); ck("network error: the claim stays (no release)", ST.patches.length === 0 && r.open_by_reminders.kept === 1 && r.open_by_reminders.released === 0); });
  await go("reread", async () => { setEnv("on"); ST.claim = [ROW("r1", "2d"), ROW("r2", "2d")]; open("r1", "r2"); ST.reqs.r1.first_delivered_at = "2026-10-28T00:00:00Z"; const r = await sweep(f);
    ck("opened in the meantime: no email, claim kept", ST.mails.length === 1 && ST.patches.length === 0 && r.open_by_reminders.skipped_opened === 1); });
  await go("texts", async () => { setEnv("on"); ST.claim = [ROW("r1", "2d"), ROW("r2", "last_day")]; open("r1", "r2"); await sweep(f);
    for (const [i, which] of [[0, "2d"], [1, "last_day"]]) { const m = ST.mails[i]; ck(which + " subject", !!m && m.subject === EXPECT[which].subject); ck(which + " body text exactly", !!m && text(m.html) === EXPECT[which].text);
      ck(which + " says Applitrust, never Verifi", !!m && /Applitrust/.test(m.subject + m.html) && !/Verifi/i.test(m.subject + m.html + m.from)); ck(which + " no em dash, no spaced double hyphen", !!m && !m.html.includes(EM) && !m.html.includes(DASH2) && !m.subject.includes(EM));
      ck(which + " from the no reply address, no Reply-To", !!m && m.from === "Applitrust <noreply@applitrust.com>" && !m.keys.some((k) => /reply/i.test(k))); ck(which + " to the requester only", !!m && m.to === "pat@corp.test");
      const foot = m ? text(m.html).split("\n").slice(-2).join("\n") : ""; ck(which + " footer exactly and last", foot === FOOT);
      ck(which + " mailto link with the address as its text", !!m && m.html.includes('<a href="mailto:support@applitrust.com">support@applitrust.com</a>')); ck(which + " support is the only address", !!m && JSON.stringify([...new Set(m.html.match(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]+/g) || [])]) === '["support@applitrust.com"]');
      ck(which + " no opt out wording and no postal address", !!m && !/unsubscrib|opt[- ]?out|stop receiving|manage (your )?(email|preferences)|street|suite|p\.?o\.? box/i.test(m.html)); }
    ck("reminder 1 has no 'first of two' line and no last reminder line", !!ST.mails[0] && !/first of two|last reminder/i.test(ST.mails[0].html)); ck("reminder 2 has the last reminder line once", !!ST.mails[1] && (ST.mails[1].html.match(/This is the last reminder about this request\./g) || []).length === 1); });
  await go("amount from the price table", async () => { setEnv("on"); ST.pricing = [{ amount_cents: 2500, currency: "usd" }]; ST.claim = [ROW("r1", "2d")]; open("r1"); await sweep(f);
    ck("the amount is read from the price table, not typed", !!ST.mails[0] && text(ST.mails[0].html).includes("\n$25.00 is charged only when you open the comparison. Nothing is charged now.\n") && !ST.mails[0].html.includes("$19.00")); });
  await go("no name", async () => { setEnv("on"); ST.claim = [ROW("r1", "2d", { requester_name: null }), ROW("r2", "last_day", { requester_name: "  " })]; open("r1", "r2"); await sweep(f);
    ck("no name: the greeting is just Hi,", ST.mails.length === 2 && ST.mails.every((m) => text(m.html).split("\n")[0] === "Hi,")); });
  await go("no leak, escaped", async () => { setEnv("on"); ST.claim = [ROW("r1", "2d", { requester_name: '<b>Pat</b> & "Co"', candidate_id: "cand-secret", candidate_label: "Candidate Label Q", atid: "ATID-7K3M-Q9XP-2WD2", candidate_name: "Casey Candidate", company: "Acme Secret Co", kind: "license_report" })]; open("r1"); await sweep(f);
    const h = ST.mails[0] ? ST.mails[0].html : ""; ck("markup in a name is escaped", h.includes("Hi &lt;b&gt;Pat&lt;/b&gt; &amp; &quot;Co&quot;,") && !h.includes("<b>Pat</b>"));
    ck("no candidate detail, ATID or company in the email", !!ST.mails[0] && !/cand-secret|Candidate Label|ATID|Casey|Acme/.test(ST.mails[0].subject + h)); });
  await go("other emails", async () => { setEnv("off"); ST.owed = [{ id: "o1" }]; ST.reqs.o1 = { id: "o1", requester_email: "boss@corp.test", requester_name: "Boss", status: "expired", approved_at: null, requester_notified_at: null }; await sweep(f);
    ck("an existing email keeps verify@ and now says Applitrust (subject untouched)", ST.mails.length === 1 && ST.mails[0].from === "Applitrust <verify@applitrust.com>" && ST.mails[0].subject === "Your Verifi comparison request was not authorized"); });
  return bad;
}
t("B1 the sweep reminders: off/unset/other, dry, test, on, price, rejection, network error, pre-send re-read, exact texts, footer, from address, escaping, no leak, existing emails", async () => { assert.deepEqual(await edgeChecks(CCR), []); });
const P1 = "    `<p>You are receiving this email because a comparison request you made in Applitrust was approved by the candidate and has not been opened yet. These reminders stop once you open the comparison.</p>` +\n";
const P2 = "    `<p>If you did not make this request, or you have a question about these emails, contact <a href=\"mailto:${SUPPORT_EMAIL}\">${SUPPORT_EMAIL}</a>.</p>`;";
const EDGE_MUT = [
  ["off still calls the claim function", (s) => mutate(s, 'if (out.mode === "off") return out;', "")],
  ["any other value treated as on", (s) => mutate(s, 'return v === "dry" || v === "test" || v === "on" ? v : "off";', 'return v === "dry" || v === "test" ? v : "on";')],
  ["dry sends", (s) => mutate(s, 'const dry = out.mode === "dry";', "const dry = false;")],
  ["dry logs an address", (s) => mutate(s, 'for (const c of claimed) { if (c.which === "last_day") out.last_day++; else out.two_day++; }', 'for (const c of claimed) { if (c.which === "last_day") out.last_day++; else out.two_day++; console.log("claimed " + c.requester_email); }')],
  ["test ignores the allowlist", (s) => mutate(s, "p_only_employer_user_ids: only }", "p_only_employer_user_ids: null }")],
  ["empty allowlist still goes ahead", (s) => mutate(s, 'if (!only.length) { console.log("candidate-comparison-requests: open-by reminders mode=test allowlist=empty claimed=0"); return out; }', "")],
  ["invalid ids kept", (s) => mutate(s, ".filter((s) => UUID.test(s));", ".filter((s) => s.length > 0);")],
  ["price unreadable still goes ahead", (s) => mutate(s, 'if (!money) { console.log("candidate-comparison-requests: open-by reminders mode=" + out.mode + " price=unreadable claimed=0"); return out; }', "")],
  ["rejection keeps the claim", (s) => mutate(s, 'else if (state === "rejected") {', 'else if (state === "never") {')],
  ["network error releases the claim", (s) => mutate(s, "} else out.kept++;", '} else { await rest(`comparison_requests?id=eq.${c.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ [column]: null }) }); out.released++; }')],
  ["no re-read before sending", (s) => mutate(s, "if (!now || now.first_delivered_at) {", "if (false) {")],
  ["limit not 20", (s) => mutate(s, "const REMINDER_LIMIT = 20;", "const REMINDER_LIMIT = 200;")],
  ["sent from the verify address", (s) => mutate(s, 'const REMINDER_FROM = "Applitrust <noreply@applitrust.com>";', 'const REMINDER_FROM = "Applitrust <verify@applitrust.com>";')],
  ["other emails keep the old display name", (s) => mutate(s, 'const DEFAULT_FROM = "Applitrust <verify@applitrust.com>";', 'const DEFAULT_FROM = "Verifi <verify@applitrust.com>";')],
  ["reply-to added", (s) => mutate(s, "body: JSON.stringify({ from, to, subject, html }),", "body: JSON.stringify({ from, to, subject, html, reply_to: from }),")],
  ["changed word in reminder 1", (s) => mutate(s, "The candidate approved your comparison request. You have until", "The candidate accepted your comparison request. You have until")],
  ["changed subject in reminder 2", (s) => mutate(s, '"Last day to open your Applitrust comparison"', '"Last day to open your Verifi comparison"')],
  ["amount typed", (s) => mutate(s, "`<p>${esc(money)} is charged only", "`<p>$19.00 is charged only")],
  ["last reminder line also in reminder 1", (s) => mutate(s, '(last ? `<p>This is the last reminder about this request.</p>` : "")', "`<p>This is the last reminder about this request.</p>`")],
  ["markup not escaped", (s) => mutate(s, '"Hi " + esc(name) + ","', '"Hi " + name + ","')],
  ["candidate detail leaked", (s) => mutate(s, "`<p>${name ? \"Hi \"", "`<p>${(r as any).candidate_label || \"\"}</p><p>${name ? \"Hi \"")],
  ["wrong support address", (s) => mutate(s, 'const SUPPORT_EMAIL = "support@applitrust.com";', 'const SUPPORT_EMAIL = "support@verifi.example";')],
  ["footer paragraph 1 missing from both", (s) => mutate(s, P1, "")],
  ["footer paragraph 1 missing from reminder 2 only", (s) => mutate(s, P1, P1.replace("    `<p>", "    (last ? \"\" : `<p>").replace("</p>` +\n", "</p>`) +\n"))],
  ["footer paragraph 2 missing", (s) => mutate(s, P2, '    "";')],
  ["footer with an unsubscribe word", (s) => mutate(s, "These reminders stop once you open the comparison.</p>", "These reminders stop once you open the comparison. Unsubscribe here.</p>")],
  ["a postal address added", (s) => mutate(s, "These reminders stop once you open the comparison.</p>", "These reminders stop once you open the comparison. 1 Main Street, Suite 4.</p>")],
];
for (const [label, mut] of EDGE_MUT) t("B2 planted bug caught: " + label, async () => {
  const bad = mut(CCR); assert.notEqual(bad, CCR);
  let list; try { list = await edgeChecks(bad); } catch (e) { list = ["did not run: " + e.message]; }
  assert.ok(list.length > 0, "edgeChecks did not notice: " + label);
});
t("B3 the reminder step comes after the expiry step in the sweep source, and a planted order swap is caught", () => {
  assert.ok(CCR.indexOf("const exp = await") < CCR.indexOf("const reminders = await runOpenByReminders();"));
  const swapped = CCR.replace("const reminders = await runOpenByReminders();", "").replace("const exp = await", "const reminders = await runOpenByReminders();\n        const exp = await");
  assert.ok(swapped.indexOf("const exp = await") > swapped.indexOf("const reminders = await runOpenByReminders();"), "the planted order is wrong, so the check above would fail");
});

// ====================================================================== C. nothing else moved
t("C1 the approval email, the not authorized email, the candidate notice and the guest link bodies are unchanged from the base commit", () => {
  const base = git("show", BASE + ":supabase/functions/candidate-comparison-requests/index.ts");
  const fn = (src, name) => { const s = src.indexOf("async function " + name + "("); assert.ok(s >= 0, name); return src.slice(s, src.indexOf("\n}\n", s) + 3); };
  for (const n of ["noticeSignedInPaidApproval", "noticeRequesterApproved", "noticeRequesterNotAuthorized", "notifyCandidate", "sendGuestLink"]) assert.equal(fn(CCR, n), fn(base, n), n);
});
t("C2 the diff to the base removes only the old sendEmail and the old end of the sweep; every added line is plain ASCII", () => {
  const d = git("diff", "-U0", BASE, "--", "supabase/functions/candidate-comparison-requests/index.ts").split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
  const removed = d.filter((l) => l[0] === "-").map((l) => l.slice(1).trim());
  assert.deepEqual(removed.sort(), [
    'async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {',
    'body: JSON.stringify({ from: "Verifi <verify@applitrust.com>", to, subject, html }),', 'return r.ok;', '} catch (_e) { return false; }',
    'return json({ ok: true, expired: exp, requester_notices_sent: noticed, candidate_notices_retried: renotified, guest_links_sent: relinked });'].sort());
  for (const l of d.filter((x) => x[0] === "+")) { assert.equal(/[^\x00-\x7f]/.test(l), false, l.slice(0, 60)); assert.equal(l.includes(EM), false); assert.equal(l.includes(DASH2), false); }
});
t("C3 only the migration, the rollback, the edge function and test files changed; nothing else (no page, no billing, no charge or hold path, no other function)", () => {
  const files = git("diff", "--name-only", BASE).split("\n").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  const all = [...new Set([...files, ...untracked])].sort();
  // ED (October 28, 2026): the base commit is older than the EA push (the PDF bullet marks). The files that push added are listed here, and candidate.html is allowed only as that exact
  // pushed version (its git blob hash is pinned), so any LATER change to the page still fails this check, as before.
  const EA_FILES = ["candidate.html", "tools/resume/check-pdf-bullets.py", "tools/resume/fixtures/ea-bullet-resume.json", "tools/resume/make-pdf-bullet-pdfs.mjs", "tools/resume/pdf-bullets-lib.mjs"];
  // EJ (October 28, 2026): the extension tutorial page and its test are new public files; the page is a new file, so no existing page is touched.
  EA_FILES.push("ext-tutorial.html", "scripts/test-ext-tutorial-page.mjs");
  const EA_CANDIDATE_BLOB = "4ea9c234a0fcc3e65b17c7beb8b7790caebd7684";
  assert.equal(git("hash-object", "candidate.html").trim(), EA_CANDIDATE_BLOB, "candidate.html is not the pushed EA version");
  assert.deepEqual(all.filter((f) => !/^tools\/resume\/test-/.test(f) && !EA_FILES.includes(f)), ["supabase/functions/candidate-comparison-requests/index.ts", "supabase/migrations/20261023010000_open_by_reminders.sql", "supabase/rollback/20261023010000_open_by_reminders_rollback.sql"]);
});
t("C4 this test file contains no em dash and no spaced double hyphen", () => { const self = fs.readFileSync(new URL("tools/resume/test-open-by-reminders.mjs", repo), "utf8"); assert.equal(self.includes(EM), false); assert.equal(/[^\x00-\x7f]/.test(self), false); assert.equal(self.split("\n").some((l) => l.includes(DASH2) && !l.includes("String.fromCharCode")), false); });

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
