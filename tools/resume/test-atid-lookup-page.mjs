// node tools/resume/test-atid-lookup-page.mjs   (no network, no model call; reads candidate.html and employer.html)
// ATID employer visibility (AR): the candidate's stored switch (candidate.html), the employer lookup form and the comparison document line (employer.html).
// Methods are cut out of the pages as written and run in small stub classes; the versions before this prompt (git 41a4479) are cut out the same way for "unchanged".
// NOT proved: how the pages look and behave in a real browser (the template engine, focus, radio groups), the real fetch to the functions, Supabase.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repo = new URL("../../", import.meta.url);
const BASE = process.env.ATID_BASE_AR || "41a4479";
const read = (p) => fs.readFileSync(new URL(p, repo), "utf8").replace(/\r\n/g, "\n");
const old = (p) => execFileSync("git", ["show", `${BASE}:${p}`], { cwd: repo, maxBuffer: 1 << 28 }).toString("utf8").replace(/\r\n/g, "\n");
const CAND = read("candidate.html"), EMP = read("employer.html"), EMP_OLD = old("employer.html");
function method(src, name) {
  let start = src.indexOf("\n  " + name + "(");
  if (start < 0) start = src.indexOf("\n  async " + name + "(");
  if (start < 0) return null;
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start + 1, end + 4);
}
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();
const tests = []; const t = (n, f) => tests.push([n, f]);

// ---------------------------------------------------------------- candidate.html: the stored switch
const CARD_START = CAND.indexOf("Let employers use my ATID</span>");
const CARD = CAND.slice(CAND.lastIndexOf('<sc-if value="{{ hasAtid }}"', CARD_START), CAND.indexOf("Basic info", CARD_START));
t("candidate page: the switch sits on the ATID card, with the agreed wording, bound to saved state (not a plain unchecked box), disabled while loading or saving", () => {
  assert.ok(CARD.includes('id="atid-employer-visible-switch" checked="{{ atidEmployerVisible }}" disabled="{{ discoverableProfileDisabled }}" sc-camel-on-change="{{ toggleAtidEmployerVisible }}"'));
  assert.ok(CARD.includes("<span>Let employers use my ATID</span>"));
  assert.ok(CARD.includes("When this is on, an employer can look you up with your name and your ATID, and your ATID appears on comparison documents. You still approve every request. When it is off, employers cannot use your ATID at all."));
  assert.ok(CARD.includes("{{ atidDisplay }}") && CARD.includes("{{ copyAtid }}"), "it is the same card as the ATID row");
});
t("candidate page: no em dash and no 'verified' in the new copy", () => {
  assert.equal(CARD.includes("—"), false); assert.equal(/verified/i.test(CARD), false);
});
t("candidate page: it is not one of the three export switches: those stay unchecked boxes read at the action; this one is bound to state and saved (the code comment says why)", () => {
  assert.ok(CAND.includes("Unlike the three export switches (unchecked on every load, never stored), this one IS stored"));
  assert.ok(CAND.includes("atidEmployerVisible: s.atidEmployerVisible,"));
  assert.equal(/id="atid-employer-visible-switch"[^>]*>/.exec(CARD)[0].includes("checked=\"{{"), true);
  for (const id of ["atid-json-switch", "atid-pdf-line-switch", "atid-pdf-meta-switch"]) assert.equal(new RegExp(`id="${id}"[^>]*checked`).test(CAND), false, id);
});
t("candidate page: the saved state is loaded from every session response and never guessed: true/false from the server wins, anything else keeps the current value (default off)", () => {
  const expr = /atidEmployerVisible: (\(profile && typeof profile\.atid_employer_visible === 'boolean'\) \? profile\.atid_employer_visible : this\.state\.atidEmployerVisible),/.exec(CAND);
  assert.ok(expr, "mapping present");
  const f = new Function("profile", "state", "return " + expr[1].replace(/this\.state/g, "state"));
  assert.equal(f({ atid_employer_visible: true }, { atidEmployerVisible: false }), true);
  assert.equal(f({ atid_employer_visible: false }, { atidEmployerVisible: true }), false, "a later load shows what the server holds");
  for (const p of [null, undefined, {}, { atid_employer_visible: "true" }, { atid_employer_visible: 1 }, { atid_employer_visible: null }]) assert.equal(f(p, { atidEmployerVisible: false }), false, JSON.stringify(p));
  assert.ok(/\n    atidEmployerVisible: false,/.test(CAND), "the initial state is off");
});
function savingClass() {
  const P = makeClass(CAND, ["savePrivacySetting", "toggleAtidEmployerVisible", "toggleDiscoverableProfile", "toggleAllowComparisonRequestsProfile"]);
  const make = (state, reply) => {
    const p = new P(); p.state = { resumeCandidateId: "cid", discoverableLoadedFor: "cid", discoverableProfileSaving: false, discoverable: true, allowComparisonRequests: true, atidEmployerVisible: false, ...state };
    p.setState = (patch) => { Object.assign(p.state, typeof patch === "function" ? patch(p.state) : patch); };
    p.SUPABASE_FN_URL = "http://fn.test"; p.SUPABASE_ANON_KEY = "anon"; p.candidateSessionToken = () => "tok";
    p.requests = [];
    globalThis.fetch = async (url, init) => { p.requests.push({ url, body: JSON.parse(init.body) }); if (reply === "throw") throw new Error("net"); return { ok: reply.ok, json: async () => reply.json }; };
    return p;
  };
  return make;
}
t("candidate page: ticking the switch saves through set-discoverable with the session, names atid_employer_visible, and shows the value the server answers", async () => {
  const p = savingClass()({}, { ok: true, json: { ok: true, discoverable: true, allow_comparison_requests: true, atid_employer_visible: true } });
  await p.toggleAtidEmployerVisible(true);
  assert.equal(p.requests.length, 1); assert.equal(p.requests[0].url, "http://fn.test/set-discoverable");
  assert.deepEqual(p.requests[0].body, { session_token: "tok", candidate_id: "cid", discoverable: true, allow_comparison_requests: true, atid_employer_visible: true });
  assert.equal(p.state.atidEmployerVisible, true); assert.equal(p.state.discoverableProfileSaved, true); assert.equal(p.state.discoverableProfileError, null);
  // the server is the truth: if it answers false the box shows false
  const q = savingClass()({}, { ok: true, json: { ok: true, atid_employer_visible: false } }); await q.toggleAtidEmployerVisible(true);
  assert.equal(q.state.atidEmployerVisible, false);
});
t("candidate page: a failed save puts the box back to what it was (off stays off, on stays on) and says so, in plain words", async () => {
  for (const [start, reply] of [[false, { ok: false, json: { ok: false } }], [false, "throw"], [true, { ok: true, json: { ok: false } }]]) {
    const p = savingClass()({ atidEmployerVisible: start }, reply);
    await p.toggleAtidEmployerVisible(!start);
    assert.equal(p.state.atidEmployerVisible, start); assert.match(p.state.discoverableProfileError, /couldn't save that change/); assert.equal(p.state.discoverableProfileSaving, false);
  }
});
t("candidate page: the other two privacy toggles never write the ATID switch (no stale copy can overwrite it); and nothing is sent before the settings have loaded", async () => {
  for (const which of ["toggleDiscoverableProfile", "toggleAllowComparisonRequestsProfile"]) {
    const p = savingClass()({ atidEmployerVisible: true }, { ok: true, json: { ok: true } });
    await p[which](false);
    assert.equal("atid_employer_visible" in p.requests[0].body, false, which);
  }
  const p = savingClass()({ discoverableLoadedFor: null }, { ok: true, json: { ok: true } }); await p.toggleAtidEmployerVisible(true);
  assert.equal(p.requests.length, 0); assert.equal(p.state.atidEmployerVisible, false);
});
t("candidate page: the switch is not kept in browser storage", () => {
  assert.equal(/(localStorage|sessionStorage)[^\n]*atidEmployerVisible|atidEmployerVisible[^\n]*(localStorage|sessionStorage)/.test(CAND), false);
});

// ---------------------------------------------------------------- employer.html: the lookup form
const LOOKUP = EMP.slice(EMP.indexOf("Check a candidate's verified record</h1>"), EMP.indexOf('<sc-if value="{{ isNoMatch }}"'));
t("employer page: the lookup form offers 'Name and email (or phone)' or 'Name and ATID'; the name field is always there; the ATID field and the exact-match note show only in ATID mode", () => {
  assert.ok(LOOKUP.includes("<span>Name and email (or phone)</span>") && LOOKUP.includes("<span>Name and ATID</span>"));
  const nameIdx = LOOKUP.indexOf('id="el-name"'), modeAtid = LOOKUP.indexOf('<sc-if value="{{ lookupModeAtid }}"'), modeContact = LOOKUP.indexOf('<sc-if value="{{ lookupModeContact }}"');
  assert.ok(nameIdx > 0 && nameIdx < modeContact && nameIdx < modeAtid, "the name is outside both conditional blocks");
  const atidBlock = LOOKUP.slice(modeAtid, LOOKUP.indexOf("</sc-if>", modeAtid));
  assert.ok(atidBlock.includes('id="el-atid"') && atidBlock.includes("The ATID is the most exact match. The name is still required and is matched the same way."));
  const contactBlock = LOOKUP.slice(modeContact, modeAtid);
  assert.ok(contactBlock.includes('id="el-email"') && contactBlock.includes('id="el-phone"') && contactBlock.includes("Give at least one of the two."));
});
t("employer page: no em dash and no 'verified' in the new copy; the form text outside the new block is unchanged from before", () => {
  const added = LOOKUP.slice(LOOKUP.indexOf("AR (October 19, 2026)"), LOOKUP.indexOf('<div class="field">\n        <label for="el-name">'));
  const atidBlock = LOOKUP.slice(LOOKUP.indexOf('<sc-if value="{{ lookupModeAtid }}"'), LOOKUP.indexOf("</sc-if>", LOOKUP.indexOf('<sc-if value="{{ lookupModeAtid }}"')));
  for (const s of [added, atidBlock]) { assert.equal(s.includes("—"), false); assert.equal(/verified/i.test(s.replace(/<!--[\s\S]*?-->/g, "")), false); }
  const oldLookup = EMP_OLD.slice(EMP_OLD.indexOf("Check a candidate's verified record</h1>"), EMP_OLD.indexOf('<sc-if value="{{ isNoMatch }}"'));
  for (const line of ["Look up whether a candidate holds a verified record. You confirm your own email address before any result is shown.", "Give at least one of the two. If you give both, they must belong to the same record."]) { assert.ok(oldLookup.includes(line)); assert.ok(LOOKUP.includes(line)); }
});
t("employer page: there is ONE no-match message and it is unchanged; the ATID result goes through the same applyExistenceResult as the email result", () => {
  assert.equal([...EMP.matchAll(/No record exists for the credentials supplied\./g)].length, 1);
  assert.equal([...EMP_OLD.matchAll(/No record exists for the credentials supplied\./g)].length, 1);
  assert.ok(EMP.includes("if (!data.exists) { this.setState({ screen: 'noMatch', lookupResult: 'none', lookup: null, request: null }); return; }"));
  assert.equal([...EMP.matchAll(/applyExistenceResult\(data\)/g)].length, [...EMP_OLD.matchAll(/applyExistenceResult\(data\)/g)].length);
});
t("employer page: lookupCandidateFields sends exactly the three old fields in the email form, and only name + ATID in the ATID form (email and phone blanked)", () => {
  const P = makeClass(EMP, ["lookupCandidateFields"]); const p = new P();
  p.state = { lookupMode: "contact", candNameInput: " Jane Doe ", candEmailInput: " jane@example.test ", candPhoneInput: " 555 ", candAtidInput: "ATID-1" };
  assert.deepEqual(p.lookupCandidateFields(), { candidate_name: "Jane Doe", candidate_email: "jane@example.test", candidate_phone: "555" });
  p.state.lookupMode = undefined; assert.deepEqual(p.lookupCandidateFields(), { candidate_name: "Jane Doe", candidate_email: "jane@example.test", candidate_phone: "555" }, "default is the old form");
  p.state.lookupMode = "atid"; assert.deepEqual(p.lookupCandidateFields(), { candidate_name: "Jane Doe", candidate_email: "", candidate_phone: "", candidate_atid: "ATID-1" });
  assert.equal([...EMP.matchAll(/\.\.\.this\.lookupCandidateFields\(\)/g)].length, 2, "both the emailed and the signed-in call use it");
});
t("employer page: the submit button needs a name of two words plus an ATID in the ATID form (and the old rule in the email form)", () => {
  const m = /lookupIncomplete: s\.lookupSending \|\| !\(([\s\S]*?)\),\n      pendingRequesterEmail/.exec(EMP);
  assert.ok(m);
  const f = new Function("s", "return !!(s.lookupSending || !(" + m[1] + "))");
  const base = { lookupSending: false, real: true, candNameInput: "Jane Doe", candEmailInput: "", candPhoneInput: "", candAtidInput: "", lookupMode: "contact" };
  assert.equal(f({ ...base }), true, "email form, nothing given");
  assert.equal(f({ ...base, candEmailInput: "a@b.test" }), false);
  assert.equal(f({ ...base, lookupMode: "atid", candEmailInput: "a@b.test" }), true, "ATID form ignores the email box");
  assert.equal(f({ ...base, lookupMode: "atid", candAtidInput: "ATID-7K3M" }), false);
  assert.equal(f({ ...base, lookupMode: "atid", candAtidInput: "ATID-7K3M", candNameInput: "Jane" }), true, "ATID without a full name");
  assert.equal(f({ ...base, lookupMode: "atid", candAtidInput: "ATID-7K3M", candNameInput: "" }), true, "ATID alone");
});

// ---------------------------------------------------------------- employer.html: the comparison document
const NAMES = ["buildComparisonLines", "sanitizeAts", "czWorkLabel", "czEduLabel", "czCertLabel", "czRange", "czPartialLabel", "groupByLiteralHeading", "wrapText"];
t("employer page: the comparison document has no ATID line unless the data carries a well-formed ATID; with none it is exactly the old document, line for line", () => {
  const NewC = makeClass(EMP, NAMES), OldC = makeClass(EMP_OLD, NAMES);
  const RES = { available: true, candidate: { name: "Jane Doe" }, header: { mode: "account", location: "Austin, TX" }, contact: { email: { value: "jane@example.test" }, phone: { value: "512-555-0101" } },
    work: [{ employer: "Acme", title: "Analyst", start: "2019-01", end: "2022-03", bullets: [{ text: "Built reports" }] }], education: [], skills: [{ text: "SQL" }] };
  const lines = (C, r) => new C().buildComparisonLines(r);
  const before = lines(OldC, RES);
  assert.ok(before.length > 3);
  for (const atid of [undefined, null, "", "ATID7K3MQ9XP2WD2", "ATID-7K3M-Q9XP-2WD", "atid-7k3m-q9xp-2wd2", "ATID-7K3M-Q9XP-2WU2", 12345, { x: 1 }]) assert.deepEqual(lines(NewC, { ...RES, atid }), before, JSON.stringify(atid));
  const on = lines(NewC, { ...RES, atid: "ATID-7K3M-Q9XP-2WD2" });
  assert.equal(on.length, before.length + 1);
  const i = on.findIndex((l) => l.text === "Applitrust ID: ATID-7K3M-Q9XP-2WD2");
  assert.ok(i > 0 && i <= 4, "right after the header block, at index " + i);
  assert.deepEqual([...on.slice(0, i), ...on.slice(i + 1)], before, "everything else is identical");
  // printed-header mode too
  const printed = { ...RES, header: { mode: "printed", printed_header: "Jane Doe\nAustin" } };
  assert.deepEqual(lines(NewC, { ...printed, atid: undefined }), lines(OldC, printed));
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
