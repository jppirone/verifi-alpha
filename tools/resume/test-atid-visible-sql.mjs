// node --experimental-strip-types tools/resume/test-atid-visible-sql.mjs   (no network, no model call, no live database)
// ATID employer visibility (AR): applies 20261019010000_atid.sql and then 20261019020000_atid_employer_visible.sql, as written, on a LOCAL in-process Postgres (PGlite from the
// other repository's node_modules; override with ATID_PGLITE) and proves the new column, its default, the staged-ATID column, that the AQ triggers are untouched, and the rollback.
// DOES NOT PROVE: the real candidates / employer_lookup_requests tables (stubs with the columns that matter), the real cleanup and delete functions, hosted Postgres, PostgREST.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PGLITE = process.env.ATID_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set ATID_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const M1 = rd("../../supabase/migrations/20261019010000_atid.sql"), M2 = rd("../../supabase/migrations/20261019020000_atid_employer_visible.sql"), RB2 = rd("../../supabase/rollback/20261019020000_atid_employer_visible_rollback.sql");

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.candidates (id uuid primary key default gen_random_uuid(), email text not null unique, first_name text, last_name text, verification_id uuid,
  account_type text not null default 'full_resume', discoverable boolean not null default false, deletion_scheduled_at timestamptz);
create table public.employer_lookup_requests (id uuid primary key default gen_random_uuid(), token text not null unique, requester_email text not null, candidate_name text, candidate_email text, candidate_phone text,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now(), used_at timestamptz,
  matched_candidate_id uuid references public.candidates(id) on delete set null);
create table public.account_deletion_log (candidate_id uuid, outcome text, billing_cleared_for timestamptz, last_attempt_at timestamptz);
create table public.purge_calls (candidate_id uuid, at timestamptz default now());
create table public.comparison_children (id uuid primary key default gen_random_uuid(), candidate_id uuid references public.candidates(id) on delete cascade);
create function public.purge_candidate_comparisons(p uuid) returns void language sql as $$ insert into public.purge_calls (candidate_id) values (p) $$;
insert into public.candidates (email, first_name, discoverable) values ('a@x.test','A',true),('b@x.test','B',false),('c@x.test','C',true);
insert into public.employer_lookup_requests (token, requester_email, candidate_name, candidate_email) values ('t1','r@x.test','A B','a@x.test');
`;
const tests = []; const t = (n, f) => tests.push([n, f]);
let db; const q = async (s, p) => (await db.query(s, p)).rows; const one = async (s, p) => Object.values((await q(s, p))[0] ?? {})[0];
const fails = async (s, p, re) => { let m = null; try { await db.query(s, p); } catch (e) { m = String(e.message); } assert.ok(m !== null, "expected an error"); if (re) assert.match(m, re); };

t("both migrations apply, in order, on tables that already hold rows", async () => {
  db = new PGlite(); await db.exec(STUB); await db.exec(M1);
  const before = await q("select id, atid from public.candidates order by email");
  await db.exec(M2);
  assert.deepEqual(await q("select id, atid from public.candidates order by email"), before, "the ATIDs are exactly as they were");
});
t("every existing candidate is false after the migration (the switch is off for everybody until they choose)", async () => {
  assert.deepEqual(await q("select atid_employer_visible v from public.candidates"), [{ v: false }, { v: false }, { v: false }]);
});
t("the column is boolean, NOT NULL, default false; a new candidate starts off, and null is refused", async () => {
  const c = (await q("select data_type, is_nullable, column_default from information_schema.columns where table_name='candidates' and column_name='atid_employer_visible'"))[0];
  assert.deepEqual(c, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
  assert.equal(await one("insert into public.candidates (email) values ('new@x.test') returning atid_employer_visible"), false);
  await fails("update public.candidates set atid_employer_visible = null where email = 'new@x.test'", [], /null value|not-null/i);
});
t("switching it on and off works, touches nothing else, and does NOT change the ATID or the registry (the AQ triggers are not involved)", async () => {
  const reg = await one("select count(*) from public.atid_registry"), atid = await one("select atid from public.candidates where email='a@x.test'");
  await db.query("update public.candidates set atid_employer_visible = true where email = 'a@x.test'");
  assert.equal(await one("select atid_employer_visible from public.candidates where email='a@x.test'"), true);
  assert.equal(await one("select atid from public.candidates where email='a@x.test'"), atid);
  assert.equal(await one("select count(*) from public.atid_registry"), reg);
  await db.query("update public.candidates set atid_employer_visible = false where email = 'a@x.test'");
  assert.equal(await one("select atid_employer_visible from public.candidates where email='a@x.test'"), false);
  await fails("update public.candidates set atid = 'ATID000000000000' where email='a@x.test'", [], /permanent/);
});
t("the AQ rules still hold with the new column present: insert ignores a supplied ATID and a delete retires it", async () => {
  const a = await one("insert into public.candidates (email, atid, atid_employer_visible) values ('z@x.test','ATID000000000000', true) returning atid");
  assert.notEqual(a, "ATID000000000000");
  await db.query("delete from public.candidates where email='z@x.test'");
  assert.ok(await one("select retired_at from public.atid_registry where atid = $1", [a]));
});
t("AS: no table the migrations touch has any column for a typed ATID: employer_lookup_requests has no atid-named column at all (the typed text is not stored)", async () => {
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='employer_lookup_requests' and column_name ilike '%atid%'")), 0);
  assert.equal(/candidate_atid/i.test(M2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")), false, "the migration adds no such column");
  const cols = (await q("select table_name, column_name from information_schema.columns where table_schema='public' and column_name ilike '%atid%' order by 1, 2")).map((r) => r.table_name + "." + r.column_name);
  assert.deepEqual(cols, ["atid_registry.atid", "candidates.atid", "candidates.atid_employer_visible"]);
});
t("AS: the id a typed ATID is turned into lives in matched_candidate_id, which the candidate's foreign key sets to null when the candidate is deleted (and the AQ delete trigger still retires the ATID)", async () => {
  const id = await one("insert into public.candidates (email, atid_employer_visible) values ('p@x.test', true) returning id");
  const atid = await one("select atid from public.candidates where id = $1", [id]);
  await db.query("insert into public.employer_lookup_requests (token, requester_email, candidate_name, matched_candidate_id) values ('t3','r@x.test','P Q',$1)", [id]);
  await db.query("insert into public.comparison_children (candidate_id) values ($1)", [id]);
  await db.query("delete from public.candidates where id = $1", [id]);
  assert.equal(await one("select matched_candidate_id from public.employer_lookup_requests where token='t3'"), null);
  assert.equal(Number(await one("select count(*) from public.comparison_children")), 0, "cascade children are gone");
  const r = (await q("select atid, retired_at from public.atid_registry where atid = $1", [atid]))[0];
  assert.ok(r && r.retired_at, "the tombstone survives the real delete and is retired");
});
t("AS: the tombstone table has no foreign key in either direction and no ON DELETE action, so nothing can cascade into it", async () => {
  assert.equal(Number(await one("select count(*) from pg_constraint where contype='f' and (conrelid='public.atid_registry'::regclass or confrelid='public.atid_registry'::regclass)")), 0);
  assert.deepEqual((await q("select column_name from information_schema.columns where table_name='atid_registry' order by ordinal_position")).map((r) => r.column_name), ["atid", "issued_at", "retired_at"]);
  const start = M1.indexOf("create table if not exists public.atid_registry");
  const ddl = M1.slice(start, M1.indexOf(");", start) + 2);
  assert.equal(/references|on delete|on update|cascade/i.test(ddl), false, ddl);
});
t("AS: deactivate then reactivate keeps the same ATID. The two REAL existing triggers on deletion_scheduled_at (taken from their migration files) fire as they always did, and the ATID triggers stay out of it", async () => {
  const mig = (f) => fs.readFileSync(new URL("../../supabase/migrations/" + f, import.meta.url), "utf8");
  const react = mig("20260921050000_account_deletion_log_reactivation.sql"), purge = mig("20260920020000_comparison_requests.sql");
  const grab = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)) + to.length);
  await db.exec(grab(react, "create or replace function trg_account_deletion_log_on_reactivation", "execute function trg_account_deletion_log_on_reactivation();"));
  await db.exec(grab(purge, "create or replace function trg_purge_comparisons_on_deactivation", "execute function trg_purge_comparisons_on_deactivation();"));
  const triggers = (await q("select tgname from pg_trigger where tgrelid='public.candidates'::regclass and not tgisinternal order by tgname")).map((r) => r.tgname);
  assert.deepEqual(triggers, ["account_deletion_log_on_reactivation", "candidates_atid_insert", "candidates_atid_no_change", "candidates_atid_retire", "purge_comparisons_on_deactivation"]);
  const id = await one("insert into public.candidates (email, atid_employer_visible) values ('react@x.test', true) returning id");
  const atid = await one("select atid from public.candidates where id = $1", [id]);
  await db.query("insert into public.account_deletion_log (candidate_id, outcome) values ($1, 'billing_cleared')", [id]);
  await db.query("update public.candidates set deletion_scheduled_at = now() + interval '30 days' where id = $1", [id]);
  assert.equal(Number(await one("select count(*) from public.purge_calls where candidate_id = $1", [id])), 1, "the purge trigger fired on deactivation");
  assert.equal(await one("select atid from public.candidates where id = $1", [id]), atid);
  await db.query("update public.candidates set deletion_scheduled_at = null where id = $1", [id]);
  assert.equal(await one("select outcome from public.account_deletion_log where candidate_id = $1", [id]), "reactivated", "the reactivation trigger fired");
  assert.equal(await one("select atid from public.candidates where id = $1", [id]), atid, "same ATID after reactivation");
  assert.equal(await one("select atid_employer_visible from public.candidates where id = $1", [id]), true, "and the switch is as it was");
  assert.equal(await one("select retired_at from public.atid_registry where atid = $1", [atid]), null, "not retired by a deactivation");
  assert.equal(Number(await one("select count(*) from public.atid_registry where atid = $1", [atid])), 1);
});
t("running the second migration twice changes nothing (idempotent)", async () => {
  await db.query("update public.candidates set atid_employer_visible = true where email='a@x.test'");
  await db.exec(M2);
  assert.equal(await one("select atid_employer_visible from public.candidates where email='a@x.test'"), true, "a chosen value survives a re-run");
});
t("the migration SQL has no statement that touches atid, verification_id, or any existing function", () => {
  const code = M2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal(/verification_id/i.test(code), false);
  assert.equal(/create (or replace )?function|drop |delete from|update public/i.test(code), false);
  assert.equal(/\batid\b\s*(=|text|,)/i.test(code.replace(/candidate_atid/gi, "").replace(/atid_employer_visible/gi, "")), false);
});
t("the rollback removes both new columns and leaves the AQ ATID column, triggers and registry alone", async () => {
  await db.exec(RB2);
  assert.equal(Number(await one("select count(*) from information_schema.columns where column_name in ('atid_employer_visible') or (table_name='employer_lookup_requests' and column_name='candidate_atid')")), 0);
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='candidates' and column_name='atid'")), 1);
  assert.equal(Number(await one("select count(*) from pg_trigger where tgrelid='public.candidates'::regclass and tgname like 'candidates_atid_%'")), 3);
  await db.query("insert into public.candidates (email) values ('after@x.test')");
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
