// node --experimental-strip-types tools/resume/test-atid-lookup.mjs   (no network, no model call, no live database)
// ATID employer lookup and comparison document (prompt AR, October 19, 2026).
// The REAL Edge Function sources (check-existence, send-lookup-confirmation, candidate-comparison-requests) are loaded as written, with only the Deno / jsr imports
// replaced, and run against a small in-memory stand-in for the database REST API (a table store that understands the filters these functions use: eq, ilike, is, gte, gt, in,
// select, limit, POST, PATCH, DELETE). The versions before this prompt (git commit 41a4479) are loaded the same way, so "unchanged" is a comparison of real responses.
// NOT proved: PostgREST itself (the stand-in is not it), real timing (we compare the sequence of database calls each case makes, not clocks), the real column and
// CHECK constraint (test-atid-sql.mjs covers those on PGlite), Resend, Supabase auth.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { atidCheckChar, atidDisplay, atidIsStored } from "../../supabase/functions/_shared/resume-atid.ts";

const repo = new URL("../../", import.meta.url);
const BASE = process.env.ATID_BASE_AR || "41a4479";
const SHARED_URL = new URL("supabase/functions/_shared/resume-atid.ts", repo).href;

// ---------------------------------------------------------------- the stand-in database
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test" })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
let DB, CALLS, FAIL;
function resetDb(seed) { DB = structuredClone(seed); CALLS = []; FAIL = {}; }
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function rowMatches(row, params) {
  for (const [k, v] of params) {
    if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
    const m = /^(eq|ilike|is|gte|gt|lt|in)\.(.*)$/s.exec(v); if (!m) continue;
    const [, op, val] = m; const cell = row[k];
    if (op === "eq") { if (cell === null || cell === undefined || String(cell) !== val) return false; }
    else if (op === "ilike") { const re = new RegExp("^" + val.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"); if (!re.test(String(cell ?? ""))) return false; }
    else if (op === "is") { if (val === "null" ? cell != null : cell == null) return false; }
    else if (op === "gte") { if (!(String(cell) >= val)) return false; }
    else if (op === "gt") { if (!(String(cell) > val)) return false; }
    else if (op === "lt") { if (!(String(cell) < val)) return false; }
    else if (op === "in") { if (!val.replace(/^\(|\)$/g, "").split(",").includes(String(cell))) return false; }
  }
  return true;
}
const project = (row, select) => { if (!select || select === "*") return { ...row }; const o = {}; for (const c of select.split(",")) if (c in row) o[c] = row[c]; return o; };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const method = (init.method || "GET").toUpperCase();
  if (u.hostname === "api.resend.com") { CALLS.push("POST resend"); return ok({ id: "m1" }); }
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(u.pathname);
  if (rpc) { CALLS.push("RPC " + rpc[1]); if (FAIL["rpc/" + rpc[1]]) return ok({}, 500); return ok(DB.__rpc[rpc[1]]); }
  const t = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!t) return ok({ error: "unknown " + u.pathname }, 404);
  const table = t[1]; CALLS.push(method + " " + table);
  if (FAIL[table] && FAIL[table] === method) return ok({ error: "forced" }, 500);
  DB[table] = DB[table] || [];
  const prefer = (init.headers && (init.headers.Prefer || init.headers.prefer)) || "";
  if (method === "GET") {
    let rows = DB[table].filter((r) => rowMatches(r, u.searchParams));
    const lim = Number(u.searchParams.get("limit")); if (lim) rows = rows.slice(0, lim);
    return ok(rows.map((r) => project(r, u.searchParams.get("select"))));
  }
  if (method === "POST") {
    const rec = JSON.parse(init.body);
    if (u.searchParams.get("on_conflict") && DB[table].some((r) => r[u.searchParams.get("on_conflict")] === rec[u.searchParams.get("on_conflict")])) return new Response(null, { status: 201 });
    const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), used_at: null, result_exists: null, matched_candidate_id: null, ...rec };
    DB[table].push(row);
    return prefer.includes("return=representation") ? ok([row], 201) : new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const patch = JSON.parse(init.body); const hit = DB[table].filter((r) => rowMatches(r, u.searchParams));
    hit.forEach((r) => Object.assign(r, patch));
    return prefer.includes("return=representation") ? ok(hit) : new Response(null, { status: 204 });
  }
  if (method === "DELETE") { DB[table] = DB[table].filter((r) => !rowMatches(r, u.searchParams)); return new Response(null, { status: 204 }); }
  return ok({}, 405);
};

// ---------------------------------------------------------------- loading real function sources
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atid-lookup-"));
let n = 0;
async function load(fn, source) {
  let src = source.replace(/\r\n/g, "\n")
    .replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "")
    .replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n")
    .replace(/from "\.\.\/_shared\/resume-atid\.ts"/g, `from "${SHARED_URL}"`)
    .replace(/from "\.\.\/_shared\/resume-heading-line\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-heading-line.ts", repo).href}"`);   // BA: candidate-comparison-requests now imports the heading finder
  const file = path.join(TMP, `${fn}-${++n}.ts`); fs.writeFileSync(file, src);
  const m = await import(pathToFileURL(file).href);
  return m.default.fetch;
}
const nowSrc = (fn) => fs.readFileSync(new URL(`supabase/functions/${fn}/index.ts`, repo), "utf8").replace(/\r\n/g, "\n");
const oldSrc = (fn) => execFileSync("git", ["show", `${BASE}:supabase/functions/${fn}/index.ts`], { cwd: repo, maxBuffer: 1 << 26 }).toString("utf8");
const NEW = { check: await load("check-existence", nowSrc("check-existence")), send: await load("send-lookup-confirmation", nowSrc("send-lookup-confirmation")), cmp: await load("candidate-comparison-requests", nowSrc("candidate-comparison-requests")) };
const OLD = { check: await load("check-existence", oldSrc("check-existence")), send: await load("send-lookup-confirmation", oldSrc("send-lookup-confirmation")), cmp: await load("candidate-comparison-requests", oldSrc("candidate-comparison-requests")) };

// ---------------------------------------------------------------- seed
const mkAtid = (body11) => "ATID" + body11 + atidCheckChar(body11);
const ID = { A: mkAtid("7K3MQ9XP2WD"), B: mkAtid("9A8B7C6D5E4"), C: mkAtid("K4TR0NX8M2V"), D: mkAtid("ZZZZZZZZZZZ"), E: mkAtid("0123456789A"), UNKNOWN: mkAtid("NPQRSTVWXYZ") };
const person = (id, first, last, email, atid, over = {}) => ({ id, email, phone: "5125550" + id.slice(-3).replace(/\D/g, "1").padStart(3, "1"), first_name: first, last_name: last, full_name: first + " " + last, discoverable: true, deletion_scheduled_at: null, atid, atid_employer_visible: true, allow_comparison_requests: true, ...over });
const SESSION = "S".repeat(40);
const SEED = {
  employer_users: [{ id: "u1", email: "boss@corp.test", name: "Boss" }],
  employer_sessions: [{ id: "s1", employer_user_id: "u1", token_hash: await sha(SESSION), expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null }],
  employer_lookup_requests: [],
  candidates: [
    person("c-a1", "Jane", "Doe", "jane@example.test", ID.A),
    person("c-b2", "John", "Roe", "john@example.test", ID.B, { atid_employer_visible: false }),
    person("c-c3", "Mary", "Poe", "mary@example.test", ID.C, { discoverable: false }),
    person("c-d4", "Dan", "Fox", "dan@example.test", ID.D, { deletion_scheduled_at: "2026-11-01T00:00:00Z" }),
    person("c-e5", "Eve", "Quinn", "eve@example.test", ID.E),
  ],
  __rpc: { assemble_customized_resume: { available: true, candidate: { name: "Jane Doe" }, header: { mode: "account" }, work: [{ employer: "Acme" }] } },
};
const call = async (fnc, payload, headers = {}) => {
  const r = await fnc(new Request("http://fn.test/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) }), {});
  return { status: r.status, text: await r.text() };
};
const sessionLookup = (fnc, p) => call(fnc, { session_token: SESSION, requester_company: "Corp", ...p });
const NOMATCH = JSON.stringify({ ok: true, exists: false });
const norm = (s) => s.replace(/[0-9a-f]{64}/g, "<hex64>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<iso>");
const seq = (calls) => calls.join(" | ");

// every console line is recorded; none may contain an ATID
const LOG = []; for (const k of ["log", "error", "warn", "info", "debug"]) console[k] = ((orig) => (...a) => { if (!String(a[0]).startsWith("  ")) LOG.push(a.map(String).join(" ")); orig(...a); })(console[k].bind(console));
const realLog = console.log.bind(console);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- name + ATID matches only with the switch on
t("name + ATID matches (switch on), in every typed form: with hyphens, spaces, lower case, no prefix, I/L/O confusions, a fuzzy name", async () => {
  const d = atidDisplay(ID.A);
  for (const typed of [d, ID.A, d.toLowerCase(), d.replace(/-/g, " "), ID.A.slice(4), d.replace("ATID", "AT1D"), "  " + d + "  ", d.replace(/-/g, "–")]) {
    resetDb(SEED);
    const r = await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: typed });
    assert.equal(r.status, 200, typed);
    const j = JSON.parse(r.text);
    assert.equal(j.exists, true, "typed " + typed);
    assert.match(j.claim_token, /^[0-9a-f]{64}$/); assert.ok(j.lookup_id); assert.equal(j.contact_used, "name and ATID", "the response never repeats the typed ATID"); assert.equal(j.candidate_name, "Jane Doe");
    assert.equal(DB.employer_lookup_requests[0].matched_candidate_id, "c-a1");
  }
  for (const name of ["jane doe", "Jane M. Doe", "Doe, Jane", "Janet Doe".replace("Janet", "Jane")]) {
    resetDb(SEED);
    assert.equal(JSON.parse((await sessionLookup(NEW.check, { candidate_name: name, candidate_atid: atidDisplay(ID.A) })).text).exists, true, name);
  }
});
t("the same lookup with the switch OFF is the plain no match, byte for byte", async () => {
  resetDb(SEED);
  const r = await sessionLookup(NEW.check, { candidate_name: "John Roe", candidate_atid: atidDisplay(ID.B) });
  assert.equal(r.status, 200); assert.equal(r.text, NOMATCH);
  // and turning it on is the only difference
  DB.candidates.find((c) => c.id === "c-b2").atid_employer_visible = true; DB.employer_lookup_requests = [];
  assert.equal(JSON.parse((await sessionLookup(NEW.check, { candidate_name: "John Roe", candidate_atid: atidDisplay(ID.B) })).text).exists, true);
});

// ---------------------------------------------------------------- every failure is identical to "no such person"
const FAILS = {
  "unknown ATID (valid check character)": { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.UNKNOWN) },
  "switch off": { candidate_name: "John Roe", candidate_atid: atidDisplay(ID.B) },
  "bad check character": { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A).slice(0, -1) + (ID.A.endsWith("0") ? "1" : "0") },
  "wrong name, right ATID": { candidate_name: "Mark Twain", candidate_atid: atidDisplay(ID.A) },
  "wrong ID: another person's ATID with this name": { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.E) },
  "candidate not discoverable": { candidate_name: "Mary Poe", candidate_atid: atidDisplay(ID.C) },
  "candidate scheduled for deletion": { candidate_name: "Dan Fox", candidate_atid: atidDisplay(ID.D) },
  "text that is not an ATID at all": { candidate_name: "Jane Doe", candidate_atid: "hello world" },
  "too short": { candidate_name: "Jane Doe", candidate_atid: "ATID-7K3M" },
  "an email address typed into the ATID box": { candidate_name: "Jane Doe", candidate_atid: "jane@example.test" },
};
t("every failure gives the identical full response (status, headers' content type, body) to an unknown person, signed-in path", async () => {
  resetDb(SEED);
  const unknownPerson = await sessionLookup(NEW.check, { candidate_name: "Nobody Atall", candidate_email: "nobody@example.test" });
  assert.equal(unknownPerson.text, NOMATCH);
  for (const [why, p] of Object.entries(FAILS)) {
    resetDb(SEED);
    const r = await sessionLookup(NEW.check, p);
    assert.deepEqual(r, { status: 200, text: NOMATCH }, why);
  }
  console.log("      " + Object.keys(FAILS).length + " kinds of failure, all exactly " + NOMATCH);
});
t("every failure makes the same sequence of database calls (our stand-in for timing), exactly two candidates queries each (resolve the typed text, then re-read by id), and the bad-check query asks for a value no row can hold", async () => {
  const seqs = new Set(); const queryUrls = [];
  for (const [why, p] of Object.entries(FAILS)) {
    resetDb(SEED);
    const seen = [];
    const inner = globalThis.fetch; globalThis.fetch = async (u, i) => { if (String(u).includes("/rest/v1/candidates")) seen.push(String(u)); return inner(u, i); };
    await sessionLookup(NEW.check, p); globalThis.fetch = inner;
    assert.equal(seen.length, 2, why + ": two candidates queries");
    assert.match(seen[1], /id=eq\./, why + ": the second one is by id");
    seqs.add(seq(CALLS)); queryUrls.push([why, seen[0]]);
  }
  assert.equal(seqs.size, 1, "all failures do the same database work: " + [...seqs].join(" // "));
  resetDb(SEED);
  const bad = queryUrls.find(([w]) => w === "bad check character")[1];
  const asked = new URL(bad).searchParams.get("atid").replace(/^eq\./, "");
  assert.equal(atidIsStored(asked), false, "the decoy cannot be any account's ATID");
  assert.notEqual(asked, atidDisplay(ID.A).replace(/-/g, ""));
});
t("ATID alone with no name (or one word) is refused with the same generic answer whether the ATID is real, unknown or garbage; nothing is looked up", async () => {
  const answers = new Set();
  for (const atid of [atidDisplay(ID.A), atidDisplay(ID.UNKNOWN), "garbage", atidDisplay(ID.A).slice(0, -1) + "Z"]) {
    for (const name of ["", "   ", "Jane"]) {
      resetDb(SEED);
      const r = await sessionLookup(NEW.check, { candidate_name: name, candidate_atid: atid });
      assert.equal(r.status, 400); answers.add(r.text);
      assert.equal(CALLS.filter((c) => c.endsWith("candidates")).length, 0, "no candidates query");
      assert.equal(DB.employer_lookup_requests.length, 0);
    }
  }
  assert.deepEqual([...answers], [JSON.stringify({ ok: false, error: "candidate_name_required" })]);
});

// ---------------------------------------------------------------- name + email unchanged
t("name + email / phone lookup: the new function answers exactly like the one before this prompt (real responses, 12 cases), and makes the same candidates queries", async () => {
  const cases = [
    { candidate_name: "Jane Doe", candidate_email: "jane@example.test" }, { candidate_name: "jane DOE", candidate_email: "JANE@example.test" },
    { candidate_name: "Jane Doe", candidate_phone: DB_PHONE("c-a1") }, { candidate_name: "Jane Doe", candidate_email: "wrong@example.test" },
    { candidate_name: "Jane Roe", candidate_email: "jane@example.test" }, { candidate_name: "John Roe", candidate_email: "john@example.test" },
    { candidate_name: "Mary Poe", candidate_email: "mary@example.test" }, { candidate_name: "Dan Fox", candidate_email: "dan@example.test" },
    { candidate_name: "Jane Doe" }, { candidate_name: "Jane", candidate_email: "jane@example.test" }, { candidate_name: "Jane Doe", candidate_email: "not-an-email" },
    { candidate_name: "Eve Quinn", candidate_email: "eve@example.test", candidate_phone: DB_PHONE("c-e5") },
  ];
  function DB_PHONE(id) { return SEED.candidates.find((c) => c.id === id).phone; }
  for (const c of cases) {
    const out = [];
    for (const f of [OLD.check, NEW.check]) {
      resetDb(SEED); const urls = [];
      const inner = globalThis.fetch; globalThis.fetch = async (u, i) => { if (String(u).includes("/rest/v1/candidates")) urls.push(String(u).replace(/select=[^&]*/, "select=*")); return inner(u, i); };
      const r = await sessionLookup(f, c); globalThis.fetch = inner;
      out.push({ status: r.status, text: norm(r.text), urls });
    }
    assert.deepEqual(out[1], out[0], JSON.stringify(c));
  }
  assert.equal(JSON.parse(norm((await (async () => { resetDb(SEED); return sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_email: "jane@example.test" }); })()).text)).exists, true);
});
t("an email lookup is never affected by the switch: a candidate with the ATID switch OFF is still found by name + email (the switch only governs the ATID)", async () => {
  resetDb(SEED);
  assert.equal(JSON.parse((await sessionLookup(NEW.check, { candidate_name: "John Roe", candidate_email: "john@example.test" })).text).exists, true);
});
t("the email and the ATID are never mixed: when an ATID is sent, a (correct) email beside it is ignored, and a wrong ATID with a right email is a no match", async () => {
  resetDb(SEED);
  assert.equal((await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_email: "jane@example.test", candidate_atid: atidDisplay(ID.UNKNOWN) })).text, NOMATCH);
});

// ---------------------------------------------------------------- scrub, rate limit, logs
t("the finished lookup row holds no typed details (match and no match); the match records the candidate, the no match records nothing; there is no ATID field on the row at all", async () => {
  for (const [p, shouldMatch] of [[{ candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) }, true], [FAILS["switch off"], false], [FAILS["bad check character"], false]]) {
    resetDb(SEED); await sessionLookup(NEW.check, p);
    const row = DB.employer_lookup_requests[0];
    assert.equal("candidate_atid" in row, false); assert.equal(row.candidate_name, null); assert.equal(row.candidate_email, null); assert.equal(row.candidate_phone, null);
    assert.ok(row.used_at); assert.equal(row.result_exists, shouldMatch); assert.equal(row.matched_candidate_id, shouldMatch ? "c-a1" : null);
    assert.equal(row.claim_token_hash != null, shouldMatch);
  }
});
t("rate limit: the ATID form uses the same limit as the email form (5 an hour per requester, then 429 rate_limited), counted on the same table", async () => {
  for (const mk of [(i) => ({ candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.UNKNOWN) }), (i) => ({ candidate_name: "Jane Doe", candidate_email: "x" + i + "@example.test" })]) {
    resetDb(SEED); const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await sessionLookup(NEW.check, mk(i))).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  }
  resetDb(SEED); for (let i = 0; i < 5; i++) await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.UNKNOWN) });
  const r = await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_email: "jane@example.test" });
  assert.deepEqual([r.status, r.text], [429, JSON.stringify({ ok: false, error: "rate_limited" })], "ATID lookups and email lookups share one allowance");
});
t("a database failure is the same real 500 for the ATID form as for the email form (not a no match)", async () => {
  for (const p of [{ candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) }, { candidate_name: "Jane Doe", candidate_email: "jane@example.test" }]) {
    resetDb(SEED); FAIL.candidates = "GET";
    const r = await sessionLookup(NEW.check, p);
    assert.deepEqual([r.status, r.text], [500, JSON.stringify({ ok: false, error: "lookup_failed" })]);
  }
});

// ---------------------------------------------------------------- the emailed (anonymous) path
t("send-lookup-confirmation turns the ATID into a candidate id and stages only the id: any ATID text is accepted with the same answer (a bad check character is NOT a form error), no contact and no ATID is still refused", async () => {
  const answers = new Set();
  for (const atid of [atidDisplay(ID.A), atidDisplay(ID.UNKNOWN), "garbage", atidDisplay(ID.A).slice(0, -1) + "0"]) {
    resetDb(SEED);
    const r = await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: atid });
    assert.equal(r.status, 200); answers.add(r.text);
    const row = DB.employer_lookup_requests[0];
    assert.equal("candidate_atid" in row, false); assert.equal(JSON.stringify(row).includes(atid), false, "the typed text is not on the row");
    assert.equal(row.matched_candidate_id ?? null, atid === atidDisplay(ID.A) ? "c-a1" : null, "only the id of the real, valid ATID");
    assert.equal(row.candidate_email, null); assert.equal(row.candidate_phone, null); assert.equal(row.used_at, null);
  }
  assert.deepEqual([...answers], [JSON.stringify({ ok: true, link_minutes: 60 })]);
  resetDb(SEED);
  const none = await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe" });
  assert.deepEqual([none.status, none.text], [400, JSON.stringify({ ok: false, error: "candidate_contact_required" })]);
});
t("send-lookup-confirmation with email / phone answers exactly like the version before (real responses) and stages the same fields", async () => {
  for (const c of [{ candidate_email: "jane@example.test" }, { candidate_phone: "(512) 555-0101" }, { candidate_email: "bad" }, {}, { candidate_name: "Solo" }]) {
    const out = [];
    for (const f of [OLD.send, NEW.send]) {
      resetDb(SEED);
      const r = await call(f, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", ...c });
      const row = DB.employer_lookup_requests[0] || {};
      out.push({ status: r.status, text: r.text, staged: [row.candidate_name, row.candidate_email, row.candidate_phone] });
    }
    assert.deepEqual(out[1], out[0], JSON.stringify(c));
  }
});
t("send-lookup-confirmation rate limit is the same for the ATID form (5, then 429)", async () => {
  resetDb(SEED); const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
});
t("the whole emailed route: staged ATID -> check-existence with the token: a match continues exactly like an email match; every failure is the identical no match; the token is single use", async () => {
  const run = async (atid, name, vis) => {
    resetDb(SEED); if (vis !== undefined) DB.candidates.find((c) => c.id === "c-a1").atid_employer_visible = vis;
    await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: name, candidate_atid: atid });
    const token = DB.employer_lookup_requests[0].token;
    const r = await call(NEW.check, { token });
    const again = await call(NEW.check, { token });
    return { r, again, row: DB.employer_lookup_requests[0] };
  };
  const good = await run(atidDisplay(ID.A), "Jane Doe");
  const g = JSON.parse(good.r.text); assert.equal(g.exists, true); assert.equal(g.contact_used, "name and ATID"); assert.equal(g.requester_email, "pat@corp.test"); assert.ok(g.session_token);
  assert.equal(good.again.status, 409); assert.equal("candidate_atid" in good.row, false);
  const strip = (s) => JSON.stringify({ ...JSON.parse(s), session_token: undefined });
  for (const [atid, name, vis] of [[atidDisplay(ID.A), "Jane Doe", false], [atidDisplay(ID.A).slice(0, -1) + "0", "Jane Doe"], [atidDisplay(ID.UNKNOWN), "Jane Doe"], [atidDisplay(ID.A), "Mark Twain"], ["garbage", "Jane Doe"]]) {
    const x = await run(atid, name, vis);
    assert.equal(x.r.status, 200); assert.equal(strip(x.r.text), NOMATCH, atid + " " + name + " " + vis);
  }
});

// ---------------------------------------------------------------- AS: the typed ATID is not persisted anywhere
const typedForms = (id) => { const d = atidDisplay(id); return [d, id, id.slice(4), d.toLowerCase(), d.replace(/-/g, " "), d.replace(/-/g, "")]; };
const leaks = (forms, extra) => {
  const hay = [["a table", JSON.stringify(Object.fromEntries(Object.entries(DB).filter(([k]) => k !== "candidates")))], ["the log", LOG.join("\n")], ...extra];
  return hay.flatMap(([where, text]) => forms.filter((f) => text.toLowerCase().includes(f.toLowerCase())).map((f) => where + ": " + f));
};
t("the typed ATID is not persisted in any table, log or response: after a match, after a no match, after a rate-limit rejection, on both doors (the candidates table itself, which holds every account's own ATID, is the one place not searched)", async () => {
  const wrongRight = atidDisplay(ID.UNKNOWN) + "x";
  const cases = {
    "signed-in door, match": [typedForms(ID.A), async () => sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) })],
    "signed-in door, no match (switch off)": [typedForms(ID.B), async () => sessionLookup(NEW.check, { candidate_name: "John Roe", candidate_atid: atidDisplay(ID.B) })],
    "signed-in door, no match (unknown)": [typedForms(ID.UNKNOWN), async () => sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.UNKNOWN) })],
    "signed-in door, bad check character": [["7K3M-Q9XP-2WD3", "ATID7K3MQ9XP2WD3"], async () => sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: "ATID-7K3M-Q9XP-2WD3" })],
    "signed-in door, garbage text": [["hello world zzz"], async () => sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: "hello world zzz" })],
  };
  for (const [why, [forms, run]] of Object.entries(cases)) {
    resetDb(SEED); LOG.length = 0;
    const r = await run();
    assert.deepEqual(leaks(forms, [["the response", r.text]]), [], why);
  }
  // rate-limit rejection, signed-in door: five earlier lookups, the sixth is refused before anything is read
  resetDb(SEED); LOG.length = 0;
  for (let i = 0; i < 5; i++) await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_email: "x" + i + "@example.test" });
  const typed = atidDisplay(ID.A); const before = CALLS.length;
  const rej = await sessionLookup(NEW.check, { candidate_name: "Jane Doe", candidate_atid: typed });
  assert.equal(rej.status, 429); assert.deepEqual(leaks(typedForms(ID.A), [["the response", rej.text]]), [], "rate-limit rejection, signed-in door");
  assert.equal(CALLS.slice(before).some((c) => c.endsWith("candidates")), false, "a rejected request reads no candidate at all");
  // the emailed door: stage (match / no match), click, and a rate-limit rejection at staging
  for (const [why, id, name, vis] of [["emailed door, match", ID.A, "Jane Doe", undefined], ["emailed door, no match (switch off)", ID.B, "John Roe", undefined], ["emailed door, no match (unknown)", ID.UNKNOWN, "Jane Doe", undefined]]) {
    resetDb(SEED); LOG.length = 0;
    const s = await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: name, candidate_atid: atidDisplay(id) });
    const staged = JSON.stringify(DB.employer_lookup_requests);
    const c = await call(NEW.check, { token: DB.employer_lookup_requests[0].token });
    assert.deepEqual(leaks(typedForms(id), [["the staging response", s.text], ["the staged row (before the click)", staged], ["the click response", c.text]]), [], why);
  }
  resetDb(SEED); LOG.length = 0;
  for (let i = 0; i < 5; i++) await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_email: "y" + i + "@example.test" });
  const rej2 = await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: typed });
  assert.equal(rej2.status, 429); assert.deepEqual(leaks(typedForms(ID.A), [["the response", rej2.text]]), [], "rate-limit rejection, emailed door");
  assert.equal(DB.employer_lookup_requests.length, 5, "a rejected staging request stores nothing");
  assert.equal(LOG.length, 0, "nothing logged");
});
t("the emailed route checks everything at the click, not when the ATID was typed: switch turned off, Allow lookup turned off, account scheduled for deletion, or the candidate deleted in between, each gives the identical no match", async () => {
  const strip = (s) => JSON.stringify({ ...JSON.parse(s), session_token: undefined });
  const mutations = {
    "switch turned off": (db) => { db.candidates.find((c) => c.id === "c-a1").atid_employer_visible = false; },
    "Allow lookup turned off": (db) => { db.candidates.find((c) => c.id === "c-a1").discoverable = false; },
    "scheduled for deletion": (db) => { db.candidates.find((c) => c.id === "c-a1").deletion_scheduled_at = "2026-12-01T00:00:00Z"; },
    "candidate deleted (foreign key sets the staged id to null)": (db) => { db.candidates = db.candidates.filter((c) => c.id !== "c-a1"); db.employer_lookup_requests.forEach((r) => { if (r.matched_candidate_id === "c-a1") r.matched_candidate_id = null; }); },
  };
  for (const [why, mutate] of Object.entries(mutations)) {
    resetDb(SEED);
    await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) });
    assert.equal(DB.employer_lookup_requests[0].matched_candidate_id, "c-a1");
    mutate(DB);
    const r = await call(NEW.check, { token: DB.employer_lookup_requests[0].token });
    assert.equal(r.status, 200); assert.equal(strip(r.text), NOMATCH, why);
  }
});
t("a staged name + ATID row is invisible to everything that reads matched_candidate_id as a result: it has no used_at and no result_exists, so no activity list, comparison request or document sees it", async () => {
  resetDb(SEED);
  await call(NEW.send, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) });
  const row = DB.employer_lookup_requests[0];
  assert.equal(row.matched_candidate_id, "c-a1"); assert.equal(row.used_at, null); assert.equal(row.result_exists, null);
  for (const fn of ["list-candidate-activity", "candidate-comparison-requests", "employer-api", "employer-document"]) {
    const src = nowSrc(fn);
    const uses = [...src.matchAll(/employer_lookup_requests\?[^`"]*matched_candidate_id[^`"]*/g)].map((m) => m[0]);
    for (const u of uses) assert.ok(/result_exists=eq\.true/.test(u) || /used_at=not\.is\.null/.test(u) || (fn === "employer-document" && src.includes("l.result_exists !== true || !l.used_at")), fn + ": " + u.slice(0, 120));
  }
});

// ---------------------------------------------------------------- logs
t("nothing the lookup does is logged: not one console line during all of the above, and none contains any ATID", () => {
  const all = LOG.join("\n");
  for (const id of Object.values(ID)) { assert.equal(all.includes(id), false); assert.equal(all.includes(atidDisplay(id)), false); assert.equal(all.includes(id.slice(4)), false); }
  assert.equal(LOG.length, 0, "console lines: " + LOG.length);
});

// ---------------------------------------------------------------- the comparison document (assemble_plain_document)
const plainDoc = (fnc, headers = { Authorization: "Bearer " + SRK }) => call(fnc, { action: "assemble_plain_document", candidate_id: "11111111-1111-4111-8111-111111111111" }, headers);
const CMPSEED = (over) => ({ ...SEED, candidates: [{ id: "11111111-1111-4111-8111-111111111111", atid: ID.A, atid_employer_visible: false, ...over }] });
t("comparison document, switch OFF: byte for byte what it was before this prompt (the same bytes as the old function), and no atid anywhere in it", async () => {
  for (const over of [{}, { atid_employer_visible: false }, { atid_employer_visible: null }, { atid_employer_visible: undefined }, { atid_employer_visible: "true" }, { atid_employer_visible: 1 }]) {
    resetDb(CMPSEED(over)); const before = await plainDoc(OLD.cmp);
    resetDb(CMPSEED(over)); const after = await plainDoc(NEW.cmp);
    assert.deepEqual(after, before, JSON.stringify(over));
    assert.equal(after.text, JSON.stringify({ ok: true, resume: SEED.__rpc.assemble_customized_resume }));
    assert.equal(/atid/i.test(after.text), false);
  }
});
t("comparison document, switch ON: the same document plus exactly one key, atid, in the display form; remove it and it is the old document", async () => {
  resetDb(CMPSEED({ atid_employer_visible: true })); const on = await plainDoc(NEW.cmp);
  assert.equal(on.status, 200);
  const j = JSON.parse(on.text); assert.equal(j.resume.atid, atidDisplay(ID.A));
  const stripped = structuredClone(j); delete stripped.resume.atid;
  resetDb(CMPSEED({})); assert.equal(JSON.stringify(stripped), (await plainDoc(OLD.cmp)).text);
});
t("comparison document: a switch that is on but an ATID that is missing or not valid, a failed read, or an unavailable resume, all give the old document; a non-service caller is refused as before", async () => {
  for (const over of [{ atid: null }, { atid: "ATID7K3MQ9XP2WD3" }, { atid: "junk" }]) {
    resetDb(CMPSEED({ atid_employer_visible: true, ...over })); const a = await plainDoc(NEW.cmp);
    resetDb(CMPSEED({ atid_employer_visible: true, ...over })); const b = await plainDoc(OLD.cmp);
    assert.deepEqual(a, b, JSON.stringify(over));
  }
  resetDb(CMPSEED({ atid_employer_visible: true })); FAIL.candidates = "GET";
  const failedRead = await plainDoc(NEW.cmp);
  resetDb(CMPSEED({})); assert.deepEqual(failedRead, await plainDoc(OLD.cmp), "a failed read of the switch means no ATID");
  resetDb(CMPSEED({ atid_employer_visible: true })); DB.__rpc = { assemble_customized_resume: { available: false } };
  assert.deepEqual(await plainDoc(NEW.cmp), (resetDb({ ...CMPSEED({}), __rpc: { assemble_customized_resume: { available: false } } }), await plainDoc(OLD.cmp)));
  resetDb(CMPSEED({ atid_employer_visible: true }));
  const denied = await plainDoc(NEW.cmp, { Authorization: "Bearer not-the-key" }); resetDb(CMPSEED({})); assert.deepEqual(denied, await plainDoc(OLD.cmp, { Authorization: "Bearer not-the-key" }));
  assert.equal(denied.status, 401);
});
t("comparison document: the switch is read fresh on every assembly (turn it off and the next open has no ATID)", async () => {
  resetDb(CMPSEED({ atid_employer_visible: true }));
  assert.ok(JSON.parse((await plainDoc(NEW.cmp)).text).resume.atid);
  DB.candidates[0].atid_employer_visible = false;
  assert.equal("atid" in JSON.parse((await plainDoc(NEW.cmp)).text).resume, false);
});
t("the two callers pass the generated document through untouched (employer-comparison, employer-api): no atid handling of their own", () => {
  for (const fn of ["employer-comparison", "employer-api"]) {
    const src = nowSrc(fn);
    assert.ok(src.includes("generatedDocument = genJson.resume"), fn);
    assert.equal(/atid/i.test(src), false, fn);
  }
});

// ---------------------------------------------------------------- the tests can fail: planted defects
t("planted defects are caught: switch gate removed, name check removed, early return on a bad check, scrub removed, switch gate removed from the document", async () => {
  const mutate = (src, from, to) => { assert.ok(src.includes(from), "plant target exists: " + from); return src.replace(from, to); };
  const chk = nowSrc("check-existence");
  const probes = {
    "switch gate removed": async () => { const f = await load("m1", mutate(chk, "(!atidMode || c.atid_employer_visible === true) &&", "")); resetDb(SEED); return (await sessionLookup(f, FAILS["switch off"])).text === NOMATCH; },
    "name check removed": async () => { const f = await load("m2", mutate(chk, "namesMatch(String(row.candidate_name || \"\"), c.first_name, c.last_name, c.full_name)", "true")); resetDb(SEED); return (await sessionLookup(f, FAILS["wrong name, right ATID"])).text === NOMATCH; },
    "early return on a bad check": async () => { const f = await load("m3", mutate(chk, "const key = reading.kind === \"atid\" ? reading.stored : \"ATID000000000001\";", "if (reading.kind !== \"atid\") return { ok: true, id: null };\n  const key = reading.stored;")); resetDb(SEED); await sessionLookup(f, FAILS["bad check character"]); const a = seq(CALLS); resetDb(SEED); await sessionLookup(f, FAILS["switch off"]); return a === seq(CALLS); },
    "typed value saved on the row": async () => { const f = await load("m4", mutate(chk, "candidate_phone: candidateAtid ? null : (candidatePhone || null),\n", "candidate_phone: candidateAtid ? null : (candidatePhone || null), candidate_atid: candidateAtid,\n")); resetDb(SEED); await sessionLookup(f, { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) }); return leaks(typedForms(ID.A), []).length === 0; },
    "typed value saved when staging": async () => { const f = await load("m7", mutate(nowSrc("send-lookup-confirmation"), "...(atidResolvedId ? { matched_candidate_id: atidResolvedId } : {}),", "candidate_atid: candidateAtid, ...(atidResolvedId ? { matched_candidate_id: atidResolvedId } : {}),")); resetDb(SEED); await call(f, { requester_email: "pat@corp.test", requester_name: "Pat", candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) }); return leaks(typedForms(ID.A), []).length === 0; },
    "typed value echoed in the response": async () => { const f = await load("m8", mutate(chk, "(atidMode ? \"name and ATID\" : \"\")", "(atidMode ? String(matched.atid) : \"\")")); resetDb(SEED); const r = await sessionLookup(f, { candidate_name: "Jane Doe", candidate_atid: atidDisplay(ID.A) }); return !/ATID/.test(JSON.parse(r.text).contact_used) ; },
    "the click trusts the staged id without re-checking Allow lookup": async () => { const f = await load("m9", mutate(chk, "c.discoverable === true &&\n        !c.deletion_scheduled_at", "!c.deletion_scheduled_at")); resetDb(SEED); return (await sessionLookup(f, FAILS["candidate not discoverable"])).text === NOMATCH; },
    "the discoverable gate removed": async () => { const f = await load("m5", mutate(chk, "c.discoverable === true &&\n        !c.deletion_scheduled_at", "!c.deletion_scheduled_at")); resetDb(SEED); return (await sessionLookup(f, FAILS["candidate not discoverable"])).text === NOMATCH; },
    "switch gate removed from the document": async () => { const f = await load("m6", mutate(nowSrc("candidate-comparison-requests"), "cand.atid_employer_visible === true && ", "")); resetDb(CMPSEED({ atid_employer_visible: false })); return !/atid/i.test((await plainDoc(f)).text); },
  };
  for (const [name, probe] of Object.entries(probes)) assert.equal(await probe(), false, "the test would NOT notice: " + name);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); realLog("  ok   " + name); } catch (e) { failed++; realLog("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 10).join("\n       ")); }
}
realLog(`\n${tests.length - failed} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
