// node --experimental-strip-types tools/resume/test-atid-prefs-sql.mjs   (no network, no model call, no live database)
// ATID stored choices and upload note (prompt AU): applies the four ATID migrations in order, as written, on a LOCAL in-process Postgres (PGlite from the other repository's
// node_modules; override with ATID_PGLITE) and proves the three export columns, the upload-note column and their rollbacks.
// DOES NOT PROVE: the real candidates / resume_documents tables (stubs with the columns that matter, the real ones are separate), hosted Postgres, PostgREST, the real cleanup functions.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PGLITE = process.env.ATID_PGLITE || "C:/Users/jpiro/fightghostjobs/contests/localdb/node_modules/@electric-sql/pglite/dist/index.js";
if (!fs.existsSync(PGLITE)) { console.log("SKIP: PGlite not found at " + PGLITE + " (set ATID_PGLITE)"); process.exit(2); }
const { PGlite } = await import(pathToFileURL(PGLITE).href);
const rd = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const M = ["20261019010000_atid.sql", "20261019020000_atid_employer_visible.sql", "20261019030000_atid_export_prefs.sql", "20261019040000_atid_upload_notice.sql"].map((f) => rd("../../supabase/migrations/" + f));
const RB3 = rd("../../supabase/rollback/20261019030000_atid_export_prefs_rollback.sql"), RB4 = rd("../../supabase/rollback/20261019040000_atid_upload_notice_rollback.sql");
const EXPORT_COLS = ["atid_export_json", "atid_export_pdf_hidden", "atid_export_pdf_line"];

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.candidates (id uuid primary key default gen_random_uuid(), email text not null unique, first_name text, verification_id uuid,
  account_type text not null default 'full_resume', discoverable boolean not null default false, deletion_scheduled_at timestamptz);
create table public.employer_lookup_requests (id uuid primary key default gen_random_uuid(), token text not null unique, requester_email text not null, candidate_name text);
create table public.resume_documents (id uuid primary key default gen_random_uuid(), candidate_id uuid, extraction_status text, ocr_raw_text text);
insert into public.candidates (email, first_name, discoverable) values ('a@x.test','A',true),('b@x.test','B',false),('c@x.test','C',true);
insert into public.resume_documents (candidate_id, extraction_status, ocr_raw_text) select id, 'extracted', 'some text' from public.candidates;
`;
const tests = []; const t = (n, f) => tests.push([n, f]);
let db; const q = async (s, p) => (await db.query(s, p)).rows; const one = async (s, p) => Object.values((await q(s, p))[0] ?? {})[0];
const fails = async (s, p, re) => { let m = null; try { await db.query(s, p); } catch (e) { m = String(e.message); } assert.ok(m !== null, "expected an error: " + s); if (re) assert.match(m, re); };

t("all four migrations apply in order on tables that already hold rows, and the ATIDs already issued are untouched", async () => {
  db = new PGlite(); await db.exec(STUB); await db.exec(M[0]); await db.exec(M[1]);
  const before = await q("select id, atid from public.candidates order by email");
  await db.exec(M[2]); await db.exec(M[3]);
  assert.deepEqual(await q("select id, atid from public.candidates order by email"), before);
});
t("every existing candidate has all three export choices OFF after the migration (existing accounts start off, nobody is opted in)", async () => {
  assert.deepEqual(await q("select atid_export_pdf_line l, atid_export_pdf_hidden h, atid_export_json j from public.candidates"), [{ l: false, h: false, j: false }, { l: false, h: false, j: false }, { l: false, h: false, j: false }]);
});
t("the three columns are boolean NOT NULL DEFAULT false; a new account starts with all off; null and non-booleans are refused", async () => {
  const cols = await q("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='candidates' and column_name like 'atid_export%' order by column_name");
  assert.deepEqual(cols.map((c) => c.column_name), EXPORT_COLS);
  for (const c of cols) assert.deepEqual([c.data_type, c.is_nullable, c.column_default], ["boolean", "NO", "false"], c.column_name);
  assert.deepEqual(await q("insert into public.candidates (email) values ('new@x.test') returning atid_export_pdf_line l, atid_export_pdf_hidden h, atid_export_json j, atid_employer_visible e"), [{ l: false, h: false, j: false, e: false }]);
  for (const c of EXPORT_COLS) await fails(`update public.candidates set ${c} = null where email = 'new@x.test'`, [], /null value|not-null/i);
  await fails("update public.candidates set atid_export_json = 'maybe' where email = 'new@x.test'", [], /boolean/i);
});
t("turning the choices on and off works, touches nothing else, and does not change the ATID or the registry (the ATID triggers are not involved)", async () => {
  const atid = await one("select atid from public.candidates where email='a@x.test'"), reg = await one("select count(*) from public.atid_registry");
  await db.query("update public.candidates set atid_export_pdf_line = true, atid_export_json = true where email = 'a@x.test'");
  assert.deepEqual(await q("select atid_export_pdf_line l, atid_export_pdf_hidden h, atid_export_json j from public.candidates where email='a@x.test'"), [{ l: true, h: false, j: true }]);
  assert.equal(await one("select atid from public.candidates where email='a@x.test'"), atid); assert.equal(await one("select count(*) from public.atid_registry"), reg);
  await db.query("update public.candidates set atid_export_pdf_line = false, atid_export_json = false where email = 'a@x.test'");
  await fails("update public.candidates set atid = 'ATID000000000000' where email='a@x.test'", [], /permanent/);
});
t("the choices survive a deactivate and a reactivate (the account keeps what it chose) and the ATID stays the same", async () => {
  await db.query("update public.candidates set atid_export_pdf_hidden = true, atid_employer_visible = true where email = 'b@x.test'");
  const atid = await one("select atid from public.candidates where email='b@x.test'");
  await db.query("update public.candidates set deletion_scheduled_at = now() + interval '30 days' where email='b@x.test'");
  await db.query("update public.candidates set deletion_scheduled_at = null where email='b@x.test'");
  assert.deepEqual(await q("select atid, atid_export_pdf_hidden h, atid_employer_visible e from public.candidates where email='b@x.test'"), [{ atid, h: true, e: true }]);
});
t("a deleted account's ATID is still retired and a re-registered person starts with every choice off and a NEW ATID", async () => {
  const old = await one("select atid from public.candidates where email='b@x.test'");
  await db.query("delete from public.candidates where email='b@x.test'");
  assert.ok(await one("select retired_at from public.atid_registry where atid = $1", [old]));
  const row = (await q("insert into public.candidates (email) values ('b@x.test') returning atid, atid_export_pdf_line l, atid_export_pdf_hidden h, atid_export_json j, atid_employer_visible e"))[0];
  assert.notEqual(row.atid, old); assert.deepEqual([row.l, row.h, row.j, row.e], [false, false, false, false]);
});
t("upload note: resume_documents.atid_on_upload is null for every existing document; it accepts only 'match', 'mismatch' or null, so an ATID (or any other text) cannot be stored there", async () => {
  assert.equal(Number(await one("select count(*) from public.resume_documents where atid_on_upload is not null")), 0);
  const id = await one("select id from public.resume_documents limit 1");
  for (const ok of ["match", "mismatch", null]) await db.query("update public.resume_documents set atid_on_upload = $1 where id = $2", [ok, id]);
  for (const bad of ["ATID-7K3M-Q9XP-2WD2", "ATID7K3MQ9XP2WD2", "none", "Match", "", "yes"]) await fails("update public.resume_documents set atid_on_upload = $1 where id = $2", [bad, id], /check/i);
  assert.equal(await one("select atid_on_upload from public.resume_documents where id = $1", [id]), null);
});
t("running the two new migrations twice changes nothing (idempotent); a chosen value survives", async () => {
  await db.query("update public.candidates set atid_export_json = true where email = 'a@x.test'");
  const id = await one("select id from public.resume_documents limit 1"); await db.query("update public.resume_documents set atid_on_upload = 'match' where id = $1", [id]);
  await db.exec(M[2]); await db.exec(M[3]);
  assert.equal(await one("select atid_export_json from public.candidates where email='a@x.test'"), true);
  assert.equal(await one("select atid_on_upload from public.resume_documents where id = $1", [id]), "match");
});
t("the new migration files touch no function, no trigger, no verification_id, and never mention an ATID value column other than their own", () => {
  for (const [i, m] of [[2, M[2]], [3, M[3]]]) {
    const code = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.equal(/verification_id/i.test(code), false, "file " + i); assert.equal(/create (or replace )?(function|trigger)|drop (function|trigger)|delete from|update public/i.test(code), false, "file " + i);
  }
});
t("the rollbacks remove exactly their own columns and leave the ATID column, its triggers and the registry alone", async () => {
  await db.exec(RB4);
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='resume_documents' and column_name='atid_on_upload'")), 0);
  await db.exec(RB3);
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='candidates' and column_name like 'atid_export%'")), 0);
  assert.equal(Number(await one("select count(*) from information_schema.columns where table_name='candidates' and column_name in ('atid','atid_employer_visible')")), 2);
  assert.equal(Number(await one("select count(*) from pg_trigger where tgrelid='public.candidates'::regclass and tgname like 'candidates_atid_%'")), 3);
  await db.query("insert into public.candidates (email) values ('after@x.test')");
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
