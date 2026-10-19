// node tools/resume/test-atid-sql.mjs   (no network, no model call, no live database)
// ATID (October 19, 2026): runs supabase/migrations/20261019010000_atid.sql, as written, on a LOCAL in-process Postgres (PGlite, loaded from the
// other repository's node_modules by absolute path; override with ATID_PGLITE=<path to pglite/dist/index.js>) and proves the registry, the
// functions (against tools/resume/atid-vectors.json, the same file the JS side uses), the three triggers, the backfill, the constraints and the
// deletion rule. It does NOT prove: the real candidates table (here a stub with the columns that matter), the 23 foreign keys to candidates, the real
// delete_candidate_account / run_account_deletions, the two existing triggers on candidates, Supabase roles and grants, or PostgREST.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { atidIsStored, atidDisplay } from "../../supabase/functions/_shared/resume-atid.ts";

const PGLITE = process.env.ATID_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set ATID_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);

const MIGRATION = fs.readFileSync(new URL("../../supabase/migrations/20261019010000_atid.sql", import.meta.url), "utf8");
const V = JSON.parse(fs.readFileSync(new URL("./atid-vectors.json", import.meta.url), "utf8"));

// the candidates table is created outside the repo's migrations; this stub has the columns the migration and the callers touch
const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text, last_name text,
  verification_id uuid,
  account_type text not null default 'full_resume',
  deletion_scheduled_at timestamptz
);
alter table public.candidates enable row level security;
insert into public.candidates (email, first_name, verification_id, account_type) values
  ('seed1@example.test', 'Seed', gen_random_uuid(), 'full_resume'),
  ('seed2@example.test', 'Seed', gen_random_uuid(), 'license_only'),
  ('seed3@example.test', 'Seed', null, 'full_resume'),
  ('seed4@example.test', null, null, 'license_only'),
  ('seed5@example.test', 'Seed', gen_random_uuid(), 'full_resume');
`;

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
let db;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => Object.values((await q(sql, params))[0] ?? {})[0];
const fails = async (sql, params, re) => { let msg = null; try { await db.query(sql, params); } catch (e) { msg = String(e.message || e); } assert.ok(msg !== null, "expected an error: " + sql); if (re) assert.match(msg, re); return msg; };

// ---------- the migration itself ----------
t("the migration applies cleanly on a table with 5 existing rows (2 license_only, 2 with no verification_id)", async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  assert.equal(Number(await one("select count(*) from public.candidates")), 5);
});
t("backfill: all 5 existing rows have a valid stored ATID (JS check too), all distinct, all registered, none retired", async () => {
  const rows = await q("select c.atid, r.atid as reg, r.retired_at from public.candidates c left join public.atid_registry r on r.atid = c.atid");
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((r) => r.atid)).size, 5);
  for (const r of rows) { assert.ok(atidIsStored(r.atid), r.atid); assert.equal(r.reg, r.atid); assert.equal(r.retired_at, null); }
  assert.equal(Number(await one("select count(*) from public.atid_registry")), 5);
});
t("the constraints exist: NOT NULL, UNIQUE, CHECK on the format", async () => {
  assert.equal(await one("select is_nullable from information_schema.columns where table_name='candidates' and column_name='atid'"), "NO");
  const cons = (await q("select conname, contype from pg_constraint where conrelid='public.candidates'::regclass and conname like 'candidates_atid%' and contype in ('c','u') order by conname")).map((r) => r.conname + ":" + r.contype);
  assert.deepEqual(cons, ["candidates_atid_format:c", "candidates_atid_key:u"]);
});
t("the CHECK refuses a malformed value even when a trigger is out of the way", async () => {
  await db.exec("alter table public.candidates disable trigger candidates_atid_no_change");
  await fails("update public.candidates set atid = 'ATID7K3MQ9XP2WD3' where email = 'seed1@example.test'", [], /candidates_atid_format/);
  await fails("update public.candidates set atid = 'nonsense' where email = 'seed1@example.test'", [], /candidates_atid_format/);
  await db.exec("alter table public.candidates enable trigger candidates_atid_no_change");
});
t("re-running nothing: the migration source never reads, writes or mentions verification_id outside comments", () => {
  const code = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal(/verification_id/i.test(code), false);
});

// ---------- the functions against the shared vector ----------
t("SQL atid_check_char over every vector body (incl. the null ones)", async () => {
  for (const c of V.check_cases) assert.equal(await one("select public.atid_check_char($1)", [c.body]), c.check, c.body);
  for (const b of V.check_null_bodies) assert.equal(await one("select public.atid_check_char($1)", [b]), null, String(b));
});
t("SQL atid_is_stored over every stored vector, and atid_valid_code on the 12 characters of the valid ones", async () => {
  for (const c of V.stored_cases) assert.equal(await one("select public.atid_is_stored($1)", [c.value]), c.valid, JSON.stringify(c.value));
  for (const c of V.stored_cases.filter((x) => x.valid)) assert.equal(await one("select public.atid_valid_code($1)", [c.value.slice(4)]), true);
});
t("SQL atid_display over every display vector", async () => {
  for (const c of V.display_cases) assert.equal(await one("select public.atid_display($1)", [c.stored]), c.display, c.stored);
});
t("SQL and JS agree on 3000 generated values: SQL generator output passes the JS check and displays the same way", async () => {
  const rows = await q("select public.atid_generate_stored() as a from generate_series(1, 3000)");
  for (const r of rows) { assert.ok(atidIsStored(r.a), r.a); assert.equal(await one("select public.atid_display($1)", [r.a]), atidDisplay(r.a)); }
  assert.ok(new Set(rows.map((r) => r.a)).size >= 2999, "3000 draws are (practically) all different");
});
t("the generator covers the whole alphabet in every body position (statistical sanity, 4000 draws)", async () => {
  const rows = await q("select public.atid_generate_stored() as a from generate_series(1, 4000)");
  for (let pos = 4; pos < 15; pos++) {
    const seen = new Set(rows.map((r) => r.a[pos]));
    assert.equal(seen.size, 32, "position " + pos + " saw " + seen.size + " of 32 characters");
  }
});

// ---------- the triggers ----------
t("insert without an atid generates one, valid and registered in the same transaction", async () => {
  const id = await one("insert into public.candidates (email, first_name) values ('new1@example.test', 'New') returning id");
  const a = await one("select atid from public.candidates where id = $1", [id]);
  assert.ok(atidIsStored(a));
  assert.equal(Number(await one("select count(*) from public.atid_registry where atid = $1 and retired_at is null", [a])), 1);
});
t("insert WITH a supplied atid: the supplied value is ignored and never registered", async () => {
  const supplied = "ATID7K3MQ9XP2WD2";
  const a = await one("insert into public.candidates (email, atid) values ('new2@example.test', $1) returning atid", [supplied]);
  assert.notEqual(a, supplied); assert.ok(atidIsStored(a));
  assert.equal(Number(await one("select count(*) from public.atid_registry where atid = $1", [supplied])), 0);
  // a malformed supplied value is ignored the same way (the check never sees it)
  const b = await one("insert into public.candidates (email, atid) values ('new3@example.test', 'garbage') returning atid");
  assert.ok(atidIsStored(b));
});
t("a duplicate-email insert fails and leaves NO registry row behind (the registration rolls back with the insert)", async () => {
  const before = Number(await one("select count(*) from public.atid_registry"));
  await fails("insert into public.candidates (email) values ('new1@example.test')", [], /duplicate key|unique/i);
  assert.equal(Number(await one("select count(*) from public.atid_registry")), before);
  assert.equal(Number(await one("select count(*) from public.candidates")), before, "one registry row per candidate while nobody has been deleted");
});
t("update that changes the atid is refused (to another value, to null); the same value and other columns are fine", async () => {
  const email = "seed1@example.test";
  const old = await one("select atid from public.candidates where email = $1", [email]);
  const other = await one("select atid from public.candidates where email = 'seed2@example.test'");
  await fails("update public.candidates set atid = $1 where email = $2", [other, email], /permanent/);
  await fails("update public.candidates set atid = null where email = $1", [email], /permanent|null value/);
  await db.query("update public.candidates set atid = $1, first_name = 'Changed' where email = $2", [old, email]);
  await db.query("update public.candidates set last_name = 'Name', deletion_scheduled_at = now() where email = $1", [email]);
  assert.equal(await one("select atid from public.candidates where email = $1", [email]), old);
});
t("delete of a candidate sets retired_at on the registry row; the row stays; nothing else in the registry changes", async () => {
  const email = "seed5@example.test";
  const a = await one("select atid from public.candidates where email = $1", [email]);
  const others = Number(await one("select count(*) from public.atid_registry where retired_at is null and atid <> $1", [a]));
  await db.query("delete from public.candidates where email = $1", [email]);
  const r = (await q("select atid, retired_at from public.atid_registry where atid = $1", [a]))[0];
  assert.equal(r.atid, a); assert.ok(r.retired_at);
  assert.equal(Number(await one("select count(*) from public.atid_registry where retired_at is null")), others);
});
t("a deleted person who registers again gets a NEW atid", async () => {
  const old = await one("select atid from public.atid_registry where retired_at is not null limit 1");
  const a = await one("insert into public.candidates (email) values ('seed5@example.test') returning atid");
  assert.notEqual(a, old); assert.ok(atidIsStored(a));
  assert.equal(await one("select retired_at is null from public.atid_registry where atid = $1", [a]), true);
  assert.ok(await one("select retired_at is not null from public.atid_registry where atid = $1", [old]), "the old one stays retired");
});
t("a retired ATID is never issued again: with a generator that keeps returning a retired value, 10 tries then the insert fails and leaves nothing", async () => {
  const retired = await one("select atid from public.atid_registry where retired_at is not null limit 1");
  const realGen = (await q("select pg_get_functiondef('public.atid_generate_stored()'::regprocedure) as d"))[0].d;
  try {
    await db.exec(`create or replace function public.atid_generate_stored() returns text language sql volatile set search_path to '' as $f$ select '${retired}'::text $f$;`);
    const before = [Number(await one("select count(*) from public.atid_registry")), Number(await one("select count(*) from public.candidates"))];
    await fails("insert into public.candidates (email) values ('collide@example.test')", [], /no free ATID after 10 tries/);
    assert.deepEqual([Number(await one("select count(*) from public.atid_registry")), Number(await one("select count(*) from public.candidates"))], before);
  } finally { await db.exec(realGen); }
});
t("collision retry: the first 3 draws are taken (one live, two retired) and the 4th is free; the insert gets the 4th", async () => {
  const live = await one("select atid from public.candidates limit 1");
  const retired = await one("select atid from public.atid_registry where retired_at is not null limit 1");
  const free = "ATIDNPQRSTVWXYZ0";
  assert.equal(Number(await one("select count(*) from public.atid_registry where atid = $1", [free])), 0);
  const realGen = (await q("select pg_get_functiondef('public.atid_generate_stored()'::regprocedure) as d"))[0].d;
  try {
    await db.exec("create sequence public.atid_test_seq");
    await db.exec(`create or replace function public.atid_generate_stored() returns text language sql volatile set search_path to '' as $f$
      select (array['${live}','${retired}','${retired}','${free}'])[least(nextval('public.atid_test_seq')::int, 4)] $f$;`);
    const a = await one("insert into public.candidates (email) values ('retry@example.test') returning atid");
    assert.equal(a, free);
  } finally { await db.exec(realGen); await db.exec("drop sequence if exists public.atid_test_seq"); }
});
t("bulk: 500 inserts all get a valid, distinct, registered ATID; registry count = candidates + retired", async () => {
  await db.exec("insert into public.candidates (email) select 'bulk' || g || '@example.test' from generate_series(1, 500) g");
  const bad = Number(await one("select count(*) from public.candidates c where not public.atid_is_stored(c.atid) or not exists (select 1 from public.atid_registry r where r.atid = c.atid and r.retired_at is null)"));
  assert.equal(bad, 0);
  assert.equal(Number(await one("select count(distinct atid) from public.candidates")), Number(await one("select count(*) from public.candidates")));
  assert.equal(Number(await one("select count(*) from public.atid_registry")), Number(await one("select count(*) from public.candidates")) + Number(await one("select count(*) from public.atid_registry where retired_at is not null")));
});

// ---------- the registry holds nothing personal ----------
t("the registry has exactly three columns (atid, issued_at, retired_at), no foreign key, no trigger; it is not readable by anon or authenticated; RLS is on", async () => {
  assert.deepEqual((await q("select column_name from information_schema.columns where table_name='atid_registry' order by ordinal_position")).map((r) => r.column_name), ["atid", "issued_at", "retired_at"]);
  assert.equal(Number(await one("select count(*) from pg_constraint where conrelid='public.atid_registry'::regclass and contype='f'")), 0);
  assert.equal(Number(await one("select count(*) from pg_constraint where confrelid='public.atid_registry'::regclass")), 0);
  assert.equal(Number(await one("select count(*) from pg_trigger where tgrelid='public.atid_registry'::regclass and not tgisinternal")), 0);
  for (const role of ["anon", "authenticated"]) for (const p of ["select", "insert", "update", "delete"]) assert.equal(await one(`select has_table_privilege('${role}', 'public.atid_registry', '${p}')`), false, role + " " + p);
  assert.equal(await one("select relrowsecurity from pg_class where oid='public.atid_registry'::regclass"), true);
});
t("no function writes the registry except the trigger path: atid_issue_new is not executable by anon or authenticated", async () => {
  for (const role of ["anon", "authenticated"]) assert.equal(await one(`select has_function_privilege('${role}', 'public.atid_issue_new()', 'execute')`), false, role);
});

// ---------- the rollback ----------
t("the rollback file removes the triggers, constraints, column and functions, keeps the registry, and leaves the stub table usable", async () => {
  const RB = fs.readFileSync(new URL("../../supabase/rollback/20261019010000_atid_rollback.sql", import.meta.url), "utf8");
  await db.exec(RB);
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='candidates' and column_name='atid'")), 0);
  assert.equal(Number(await one("select count(*) from pg_proc where proname like 'atid\\_%' or proname like 'trg\\_candidates\\_atid%'")), 0);
  assert.equal(Number(await one("select count(*) from pg_trigger where tgrelid='public.candidates'::regclass and not tgisinternal")), 0);
  assert.ok(Number(await one("select count(*) from public.atid_registry")) > 500, "the registry is kept");
  await db.query("insert into public.candidates (email) values ('after-rollback@example.test')");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
