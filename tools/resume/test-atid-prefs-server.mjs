// node --experimental-strip-types tools/resume/test-atid-prefs-server.mjs   (no network, no model call, no live database)
// ATID stored choices (prompt AU): the REAL source of set-atid-preferences, resolve-session, candidate-comparison-requests and check-existence is loaded as written (only the Deno / jsr
// imports replaced) and run against a small in-memory stand-in for the database REST API. Proves: booleans only (anything else is a 400 and NOTHING is written), only the flags
// sent are written, the candidate's own session is required, the profile read returns the four booleans (false by default), and none of the choices reaches an employer-facing answer.
// NOT proved: PostgREST itself, the real tables, Supabase auth.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = new URL("../../", import.meta.url);
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test" })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

let DB, CALLS;
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function rowMatches(row, params) {
  for (const [k, v] of params) {
    if (["select", "limit", "order"].includes(k)) continue;
    const m = /^(eq|is|ilike|gte)\.(.*)$/s.exec(v); if (!m) continue;
    if (m[1] === "eq" && String(row[k]) !== m[2]) return false;
    if (m[1] === "is" && (m[2] === "null" ? row[k] != null : row[k] == null)) return false;
    if (m[1] === "ilike" && !String(row[k] ?? "").toLowerCase().includes(m[2].toLowerCase().replace(/\*/g, ""))) return false;
    if (m[1] === "gte" && !(String(row[k]) >= m[2])) return false;
  }
  return true;
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const method = (init.method || "GET").toUpperCase();
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(u.pathname); if (rpc) { CALLS.push({ method: "RPC", table: rpc[1], url: String(url) }); return ok(DB.__rpc[rpc[1]]); }
  const t = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!t) return ok({}, 404);
  const table = t[1]; CALLS.push({ method, table, url: String(url), body: init.body ? JSON.parse(init.body) : null });
  DB[table] = DB[table] || [];
  if (method === "GET") {
    const sel = u.searchParams.get("select");
    return ok(DB[table].filter((r) => rowMatches(r, u.searchParams)).map((r) => { if (!sel || sel === "*") return { ...r }; const o = {}; for (const c of sel.split(",")) if (c in r) o[c] = r[c]; return o; }));
  }
  if (method === "PATCH") { const hit = DB[table].filter((r) => rowMatches(r, u.searchParams)); hit.forEach((r) => Object.assign(r, JSON.parse(init.body))); return init.headers?.Prefer?.includes("return=representation") ? ok(hit) : new Response(null, { status: 204 }); }
  if (method === "POST") { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), used_at: null, ...JSON.parse(init.body) }; DB[table].push(row); return ok([row], 201); }
  return ok({}, 405);
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atid-prefs-"));
let n = 0;
async function load(fn) {
  const src = fs.readFileSync(new URL(`supabase/functions/${fn}/index.ts`, repo), "utf8").replace(/\r\n/g, "\n")
    .replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "")
    .replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n")
    .replace(/from "\.\.\/_shared\/resume-atid\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-atid.ts", repo).href}"`)
    .replace(/from "\.\.\/_shared\/resume-heading-line\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-heading-line.ts", repo).href}"`);   // BA: candidate-comparison-requests now imports the heading finder
  const file = path.join(TMP, `${fn}-${++n}.ts`); fs.writeFileSync(file, src);
  return (await import(pathToFileURL(file).href)).default.fetch;
}
const SET = await load("set-atid-preferences"), RESOLVE = await load("resolve-session"), CMP = await load("candidate-comparison-requests"), CHECK = await load("check-existence");
const call = async (f, payload, headers = {}) => { const r = await f(new Request("http://fn.test/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) }), {}); return { status: r.status, text: await r.text() }; };

const CID = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "T".repeat(40), TOKEN2 = "U".repeat(40);
const ATID = "ATID7K3MQ9XP2WD2";
async function seed(over = {}) {
  DB = {
    candidate_sessions: [
      { token_hash: await sha(TOKEN), candidate_id: CID, expires_at: "2099-01-01T00:00:00Z", revoked_at: null },
      { token_hash: await sha(TOKEN2), candidate_id: OTHER, expires_at: "2099-01-01T00:00:00Z", revoked_at: null },
    ],
    candidates: [
      { id: CID, email: "a@x.test", first_name: "A", last_name: "Person", full_name: "A Person", atid: ATID, atid_employer_visible: false, atid_export_pdf_line: false, atid_export_pdf_hidden: false, atid_export_json: false, discoverable: true, deletion_scheduled_at: null, ...over },
      { id: OTHER, email: "b@x.test", first_name: "B", atid: "ATID000000000000", atid_employer_visible: false, atid_export_pdf_line: false, atid_export_pdf_hidden: false, atid_export_json: false },
    ],
    __rpc: { assemble_customized_resume: { available: true, candidate: { name: "A" }, header: { mode: "account" } } },
  };
  CALLS = [];
}
const patches = () => CALLS.filter((c) => c.method === "PATCH" && c.table === "candidates");
const FLAGS = ["atid_export_pdf_line", "atid_export_pdf_hidden", "atid_export_json", "atid_employer_visible"];
const tests = []; const t = (name, fn) => tests.push([name, fn]);

t("set-atid-preferences: a valid single flag by the candidate's own session writes exactly that flag and answers with all four saved values", async () => {
  for (const f of FLAGS) {
    await seed();
    const r = await call(SET, { candidate_id: CID, session_token: TOKEN, [f]: true });
    assert.equal(r.status, 200); const j = JSON.parse(r.text);
    assert.equal(j.ok, true); for (const g of FLAGS) assert.equal(j[g], g === f, f + "/" + g);
    assert.equal(patches().length, 1); assert.deepEqual(patches()[0].body, { [f]: true });
    assert.equal(DB.candidates[0][f], true);
    const off = await call(SET, { candidate_id: CID, session_token: TOKEN, [f]: false });
    assert.equal(JSON.parse(off.text)[f], false); assert.equal(DB.candidates[0][f], false);
  }
});
t("set-atid-preferences: booleans only. Strings, numbers, null, objects, arrays are each a 400 bad_flag and NOTHING is written (also when one flag in the call is fine)", async () => {
  for (const f of FLAGS) for (const bad of ["true", "false", "yes", 1, 0, null, "", {}, [], [true]]) {
    await seed();
    const r = await call(SET, { candidate_id: CID, session_token: TOKEN, [f]: bad });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [400, "bad_flag"], f + " " + JSON.stringify(bad));
    assert.equal(patches().length, 0, "nothing written: " + f + " " + JSON.stringify(bad));
    if (f !== "atid_export_json") {
      const mixed = await call(SET, { candidate_id: CID, session_token: TOKEN, atid_export_json: true, [f]: bad });
      assert.equal(mixed.status, 400); assert.equal(patches().length, 0, "a good flag beside a bad one is not written either");
    }
  }
});
t("set-atid-preferences: a call with no flag is a 400 no_flag; only flags are ever written (an atid, email or other field in the body is ignored, so the ATID cannot be changed through it)", async () => {
  await seed();
  const none = await call(SET, { candidate_id: CID, session_token: TOKEN });
  assert.deepEqual([none.status, JSON.parse(none.text).error], [400, "no_flag"]); assert.equal(patches().length, 0);
  const sneaky = await call(SET, { candidate_id: CID, session_token: TOKEN, atid: "ATID000000000000", email: "x@y.test", tier: "paid", atid_export_json: true });
  assert.equal(sneaky.status, 200); assert.deepEqual(patches()[0].body, { atid_export_json: true });
  assert.equal(DB.candidates[0].atid, ATID); assert.equal(DB.candidates[0].email, "a@x.test");
});
t("set-atid-preferences: only the candidate's OWN session works (no token, a bad token, someone else's token, another candidate's id are the same 401); the service key works; a bad id is a 400", async () => {
  for (const [why, payload, headers] of [["no token", { candidate_id: CID, atid_export_json: true }], ["bad token", { candidate_id: CID, session_token: "x".repeat(40), atid_export_json: true }], ["someone else's token", { candidate_id: CID, session_token: TOKEN2, atid_export_json: true }], ["anon key as bearer", { candidate_id: CID, atid_export_json: true }, { Authorization: "Bearer anon-key" }]]) {
    await seed();
    const r = await call(SET, payload, headers || {});
    assert.deepEqual([r.status, r.text], [401, JSON.stringify({ ok: false, error: "unauthorized" })], why); assert.equal(patches().length, 0, why);
  }
  await seed();
  assert.equal((await call(SET, { candidate_id: CID, atid_export_json: true }, { Authorization: "Bearer " + SRK })).status, 200);
  await seed();
  assert.equal((await call(SET, { candidate_id: "not-a-uuid", atid_export_json: true }, { Authorization: "Bearer " + SRK })).status, 400);
});
t("set-atid-preferences: a database failure is a 500 update_failed (the page then puts the box back); an unknown candidate is a 404", async () => {
  await seed();
  const real = globalThis.fetch; globalThis.fetch = async (u, i) => (i?.method === "PATCH" ? ok({ error: "x" }, 500) : real(u, i));
  const r = await call(SET, { candidate_id: CID, session_token: TOKEN, atid_export_json: true }); globalThis.fetch = real;
  assert.deepEqual([r.status, JSON.parse(r.text).error], [500, "update_failed"]);
  await seed(); DB.candidates = [];
  const gone = await call(SET, { candidate_id: CID, atid_export_json: true }, { Authorization: "Bearer " + SRK });
  assert.equal(gone.status, 404);
});

t("the profile read (resolve-session) returns the four choices as real booleans: false for a new or existing account, true only when the column is exactly true", async () => {
  await seed();
  let r = JSON.parse((await call(RESOLVE, { session_token: TOKEN })).text);
  for (const f of FLAGS) assert.equal(r[f], false, f);
  await seed({ atid_export_pdf_line: true, atid_export_json: true, atid_employer_visible: true });
  r = JSON.parse((await call(RESOLVE, { session_token: TOKEN })).text);
  assert.deepEqual([r.atid_export_pdf_line, r.atid_export_pdf_hidden, r.atid_export_json, r.atid_employer_visible], [true, false, true, true]);
  for (const junk of ["true", 1, null, undefined]) { await seed({ atid_export_json: junk, atid_export_pdf_line: junk }); r = JSON.parse((await call(RESOLVE, { session_token: TOKEN })).text); assert.equal(r.atid_export_json, false); assert.equal(r.atid_export_pdf_line, false); }
  const get = CALLS.find((c) => c.method === "GET" && c.table === "candidates");
  for (const f of ["atid_export_pdf_line", "atid_export_pdf_hidden", "atid_export_json"]) assert.ok(new URL(get.url).searchParams.get("select").split(",").includes(f), f);
});
t("none of the choices reaches an employer-facing answer: the comparison document and the lookup never carry them, with every choice turned on", async () => {
  await seed({ atid_export_pdf_line: true, atid_export_pdf_hidden: true, atid_export_json: true, atid_employer_visible: true });
  const doc = await call(CMP, { action: "assemble_plain_document", candidate_id: CID }, { Authorization: "Bearer " + SRK });
  assert.equal(doc.status, 200); assert.equal(/atid_export|pdf_line|pdf_hidden/.test(doc.text), false);
  assert.equal(JSON.parse(doc.text).resume.atid, "ATID-7K3M-Q9XP-2WD2", "only the ATID itself, by the employer switch, as before");
  const read = CALLS.filter((c) => c.method === "GET" && c.table === "candidates").map((c) => new URL(c.url).searchParams.get("select")).join(",");
  assert.equal(/atid_export/.test(read), false, "the employer-facing read does not even select them");
  const lookup = CALLS.length;
  DB.employer_users = [{ id: "u1", email: "boss@corp.test", name: "Boss" }]; DB.employer_sessions = [{ token_hash: await sha("S".repeat(40)), employer_user_id: "u1", expires_at: "2099-01-01T00:00:00Z", revoked_at: null }]; DB.employer_lookup_requests = [];
  const res = await call(CHECK, { session_token: "S".repeat(40), candidate_name: "A Person", candidate_atid: "ATID-7K3M-Q9XP-2WD2" });
  assert.equal(/atid_export|pdf_line|pdf_hidden/.test(res.text), false);
  assert.equal(JSON.parse(res.text).exists, true, "the lookup did run and matched");
  assert.equal(CALLS.slice(lookup).filter((c) => c.table === "candidates").some((c) => /atid_export/.test(c.url)), false);
});
t("static: no employer-facing function source mentions the export choices (only set-atid-preferences and the five profile reads do)", () => {
  const dir = new URL("supabase/functions/", repo);
  const hits = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).filter((nm) => { const p = new URL(`${nm}/index.ts`, dir); return fs.existsSync(p) && /atid_export/.test(fs.readFileSync(p, "utf8")); }).sort();
  assert.deepEqual(hits, ["check-login-status", "check-verification-status", "confirm-login", "confirm-verification", "resolve-session", "set-atid-preferences"]);
});

let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
