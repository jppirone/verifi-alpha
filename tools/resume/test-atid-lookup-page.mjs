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
  assert.ok(CARD.includes('id="atid-employer-visible-switch" checked="{{ atidEmployerVisible }}" disabled="{{ atidEmployerSaving }}" sc-camel-on-change="{{ toggleAtidEmployerVisible }}"'));
  assert.ok(CARD.includes("<span>Let employers use my ATID</span>"));
  // BA Part 5e (October 21, 2026): John merged "one switch covers lookup by name plus ATID and the ATID on the comparison document" into this note; the lookup still also needs "Allow lookup", so that condition stays in the sentence.
  assert.ok(CARD.includes('When this is on, an employer who types your name and your ATID can find your account (while "Let employers confirm I have an account here" is also on), and your ATID is shown on the comparison document that employer receives. You approve every request. Turn it off and your ATID does not work for lookup, and it stops appearing on an employer\'s comparison document the next time they open it.'));   // BI: the switch text now says the ATID leaves the document at the next open
  assert.equal(CARD.includes("can look you up"), false, "the old, over-promising wording is gone");
  assert.ok(CARD.includes("{{ atidDisplay }}") && CARD.includes("{{ copyAtid }}"), "it is the same card as the ATID row");
});
t("candidate page (AS): the real label of Allow lookup is quoted, and a note beside the switch appears only when Allow lookup is really off; the switch itself is never disabled by it", () => {
  const label = /<span>(Let employers confirm I have an account here)<\/span>/.exec(CAND)[1];
  assert.ok(CARD.includes('"' + label + '"'));
  assert.ok(CARD.includes('<sc-if value="{{ atidLookupIsOff }}"'));
  assert.ok(CARD.includes('Employers cannot find you by ATID until "' + label + '" is turned on.'));
  const sw = /<input type="checkbox" id="atid-employer-visible-switch"[^>]*>/.exec(CARD)[0];
  assert.equal(/atidLookupIsOff/.test(sw), false, "the note does not touch the switch");
  const m = /atidLookupIsOff: ([^\n]*),\n/.exec(CAND); assert.ok(m);
  const f = new Function("s", "return " + m[1]);
  const base = { discoverableLoadedFor: "cid", resumeCandidateId: "cid", discoverable: false };
  assert.equal(f(base), true, "loaded and off: shown");
  assert.equal(f({ ...base, discoverable: true }), false, "on: hidden");
  assert.equal(f({ ...base, discoverableLoadedFor: null }), false, "not loaded yet: no guess");
  assert.equal(f({ ...base, resumeCandidateId: "" , discoverableLoadedFor: ""}), false, "no candidate: hidden");
  // it follows the Allow lookup box live, across re-renders, because it is computed from state on every render and does not depend on the ATID switch
  for (const atidEmployerVisible of [true, false]) assert.equal(f({ ...base, atidEmployerVisible }), true);
});
t("candidate page: no em dash and no 'verified' in the new copy", () => {
  assert.equal(CARD.includes("—"), false); assert.equal(/verified/i.test(CARD), false);
});
t("candidate page (AU): the employer switch and the three export choices are all stored on the account, bound to saved page state, and say so in a code comment", () => {
  assert.ok(CAND.includes("are all stored on the account (columns atid_export_pdf_line, atid_export_pdf_hidden, atid_export_json, default off)"));
  assert.ok(CAND.includes("atidEmployerVisible: s.atidEmployerVisible,"));
  assert.equal(/id="atid-employer-visible-switch"[^>]*>/.exec(CARD)[0].includes("checked=\"{{"), true);
  for (const id of ["atid-json-switch", "atid-pdf-line-switch", "atid-pdf-meta-switch"]) assert.equal(new RegExp(`id="${id}"[^>]*checked="\\{\\{`).test(CAND), true, id);
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
  const P = makeClass(CAND, ["savePrivacySetting", "saveAtidFlag", "atidPdfSwitchChanged", "toggleAtidEmployerVisible", "toggleDiscoverableProfile", "toggleAllowComparisonRequestsProfile"]);
  const make = (state, reply) => {
    const p = new P(); p.state = { resumeCandidateId: "cid", discoverableLoadedFor: "cid", discoverableProfileSaving: false, discoverable: true, allowComparisonRequests: true, atidEmployerVisible: false, ...state };
    p.setState = (patch, cb) => { Object.assign(p.state, typeof patch === "function" ? patch(p.state) : patch); if (cb) cb(); };
    p.SUPABASE_FN_URL = "http://fn.test"; p.SUPABASE_ANON_KEY = "anon"; p.candidateSessionToken = () => "tok";
    p.requests = [];
    globalThis.fetch = async (url, init) => { p.requests.push({ url, body: JSON.parse(init.body) }); if (reply === "throw") throw new Error("net"); return { ok: reply.ok, json: async () => reply.json }; };
    return p;
  };
  return make;
}
t("candidate page (AU): ticking the employer switch saves through set-atid-preferences with the session, sends ONLY that flag, and shows the value the server answers", async () => {
  const p = savingClass()({}, { ok: true, json: { ok: true, atid_export_pdf_line: false, atid_export_pdf_hidden: false, atid_export_json: false, atid_employer_visible: true } });
  await p.toggleAtidEmployerVisible(true);
  assert.equal(p.requests.length, 1); assert.equal(p.requests[0].url, "http://fn.test/set-atid-preferences");
  assert.deepEqual(p.requests[0].body, { session_token: "tok", candidate_id: "cid", atid_employer_visible: true });
  assert.equal(p.state.atidEmployerVisible, true); assert.equal(p.state.atidFlagSaving, false); assert.equal(p.state.atidFlagError, null);
  // the server is the truth: if it answers false the box shows false
  const q = savingClass()({}, { ok: true, json: { ok: true, atid_employer_visible: false } }); await q.toggleAtidEmployerVisible(true);
  assert.equal(q.state.atidEmployerVisible, false);
});
t("candidate page (AU): a failed save puts the employer switch back to what it was (off stays off, on stays on) and says so, in plain words", async () => {
  for (const [start, reply] of [[false, { ok: false, json: { ok: false } }], [false, "throw"], [true, { ok: true, json: { ok: false } }], [true, { ok: true, json: { ok: true } }]]) {
    const p = savingClass()({ atidEmployerVisible: start }, reply);
    await p.toggleAtidEmployerVisible(!start);
    assert.equal(p.state.atidEmployerVisible, start); assert.match(p.state.atidFlagError, /couldn't save that change/); assert.equal(p.state.atidFlagErrorWhere, "card"); assert.equal(p.state.atidFlagSaving, false);
  }
});
t("candidate page (AU): the employer switch no longer depends on the privacy settings having loaded, and the other two privacy toggles never carry it", async () => {
  for (const which of ["toggleDiscoverableProfile", "toggleAllowComparisonRequestsProfile"]) {
    const p = savingClass()({ atidEmployerVisible: true }, { ok: true, json: { ok: true } });
    await p[which](false);
    assert.equal("atid_employer_visible" in p.requests[0].body, false, which);
  }
  const p = savingClass()({ discoverableLoadedFor: null }, { ok: true, json: { ok: true, atid_employer_visible: true } }); await p.toggleAtidEmployerVisible(true);
  assert.equal(p.requests.length, 1, "saved even though Allow lookup has not loaded"); assert.equal("discoverable" in p.requests[0].body, false, "and it never carries a Allow lookup value"); assert.equal(p.state.atidEmployerVisible, true);
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
// BA (October 21, 2026): the employer document's job heading now uses the candidate-PDF heading methods, so they are cut out too.
const NAMES = ["buildComparisonLines", "sanitizeAts", "czWorkLabel", "czEduLabel", "czCertLabel", "czRange", "czPartialLabel", "groupByLiteralHeading", "wrapText", "workHeadingLines", "wrapHeadingRuns", "helvWidth", "czDatesText"];
t("employer page: the comparison document has no ATID line unless the data carries a well-formed ATID; with none it is exactly the old document, line for line", () => {
  const NewC = makeClass(EMP, NAMES), OldC = makeClass(EMP_OLD, NAMES);
  const RES = { available: true, candidate: { name: "Jane Doe" }, header: { mode: "account", location: "Austin, TX" }, contact: { email: { value: "jane@example.test" }, phone: { value: "512-555-0101" } },
    work: [{ employer: "Acme", title: "Analyst", start: "2019-01", end: "2022-03", bullets: [{ text: "Built reports" }] }], education: [], skills: [{ text: "SQL" }] };
  const lines = (C, r) => new C().buildComparisonLines(r);
  // BA (October 21, 2026): the job heading changed on purpose (it is now generated like the candidate's PDF), so the baseline is the current builder with no ATID key; what this test guards, that an
  // ATID adds exactly one line and nothing else moves, is unchanged. (The old-builder comparison cannot hold for the job heading any more.)
  const before = lines(NewC, RES);
  assert.ok(before.length > 3);
  for (const atid of [undefined, null, "", "ATID7K3MQ9XP2WD2", "ATID-7K3M-Q9XP-2WD", "atid-7k3m-q9xp-2wd2", "ATID-7K3M-Q9XP-2WU2", 12345, { x: 1 }]) assert.deepEqual(lines(NewC, { ...RES, atid }), before, JSON.stringify(atid));
  // BA, Part 1: the ATID is no longer a text line in the header; the PDF writer draws it at the bottom of the last page (comparisonAtidLine). So the lines never change with an ATID, and the
  // line text exists only for a well-formed ATID.
  const on = lines(NewC, { ...RES, atid: "ATID-7K3M-Q9XP-2WD2" });
  assert.deepEqual(on, before, "an ATID adds no text line");
  const P0 = new (makeClass(EMP, [...NAMES, "comparisonAtidLine"]))();
  assert.equal(P0.comparisonAtidLine({ atid: "ATID-7K3M-Q9XP-2WD2" }), "Applitrust ID: ATID-7K3M-Q9XP-2WD2");
  for (const atid of [undefined, null, "", "ATID7K3MQ9XP2WD2", "ATID-7K3M-Q9XP-2WD", "atid-7k3m-q9xp-2wd2", "ATID-7K3M-Q9XP-2WU2", 12345, { x: 1 }]) assert.equal(P0.comparisonAtidLine({ atid }), "", JSON.stringify(atid));
  // printed-header mode too
  const printed = { ...RES, header: { mode: "printed", printed_header: "Jane Doe\nAustin" } };
  assert.deepEqual(lines(NewC, { ...printed, atid: undefined }), lines(NewC, printed));
});

// ---------------------------------------------------------------- AS: every way the comparison document can reach the employer's screen
const fnSrc = (fn) => read(`supabase/functions/${fn}/index.ts`);
t("document paths, server: every generated_document the employer pages ever receive comes from ONE place, the assemble_plain_document call (employer-api 2 sites, employer-comparison 1 site), passed on untouched", () => {
  const api = fnSrc("employer-api"), cmp = fnSrc("employer-comparison");
  const count = (s, re) => [...s.matchAll(re)].length;
  assert.equal(count(api, /action: "assemble_plain_document"/g), 2); assert.equal(count(api, /generatedDocument = genJson\.resume/g), 2);
  assert.equal(count(cmp, /action: "assemble_plain_document"/g), 1); assert.equal(count(cmp, /generatedDocument = genJson\.resume/g), 1);
  for (const s of [api, cmp]) for (const m of s.matchAll(/generated_document[^\n]*/g)) assert.ok(/generated_document: generatedDocument|generated_document \}|generated_document,|const \{ document, generated_document \}|generated_document: unknown|generated_document\)/.test(m[0]) || /\/\/|^\s*\*/.test(m[0]), m[0].slice(0, 120));
  // no other function builds or returns a generated document
  for (const f of fs.readdirSync(new URL("supabase/functions", repo))) { if (["employer-api", "employer-comparison", "candidate-comparison-requests"].includes(f)) continue; const p = new URL(`supabase/functions/${f}/index.ts`, repo); if (fs.existsSync(p)) assert.equal(/generated_document|assemble_plain_document/.test(fs.readFileSync(p, "utf8")), false, f); }
});
t("document paths, page: there is one opener (showCompare, called from 4 places that pass the server payload straight in), one place that stores the document, one that draws it, and no print or export code of its own", () => {
  const idx = [...EMP.matchAll(/this\.showCompare\(/g)].map((m) => m.index);
  assert.equal(idx.length, 4, "four openers");
  for (const i of idx) { const chunk = EMP.slice(i, i + 700); assert.ok(/\},\s*(d|x),\s*\{/.test(chunk), "passes the server payload unchanged: " + chunk.slice(0, 80)); }
  assert.ok(EMP.includes("showGuestDelivered(d) {\n    const x = d.delivered;"), "x is the server's delivered object, untouched");
  assert.equal([...EMP.matchAll(/generatedDocument:/g)].length, 1, "stored in one place");
  assert.equal([...EMP.matchAll(/cmp\.generatedDocument/g)].length, 1, "read in one place");
  assert.equal([...EMP.matchAll(/this\.buildComparisonLines\(/g)].length, 1); assert.equal([...EMP.matchAll(/this\.buildComparisonPdfBytes\(/g)].length, 1);
  assert.equal([...EMP.matchAll(/this\._genDocUrl = URL\.createObjectURL/g)].length, 1, "the viewer is given one blob, built from those lines");
  assert.equal(/window\.print|\.print\(\)|download\s*=|a\.download|exportCompar|saveAs\(/i.test(EMP.slice(EMP.indexOf("renderGeneratedDocument()"), EMP.indexOf("renderGeneratedDocument()") + 2500)), false, "no print / download code beside the document");
});
t("document paths, behaviour: for each of the four openers' payload, the document the employer is shown has the Applitrust ID line only when the server sent an atid (switch on), and nothing else changes", () => {
  const P = makeClass(EMP, ["showCompare", "comparisonAtidLine", "buildComparisonLines", "sanitizeAts", "czWorkLabel", "czEduLabel", "czCertLabel", "czRange", "czPartialLabel", "groupByLiteralHeading", "wrapText", "workHeadingLines", "wrapHeadingRuns", "helvWidth", "czDatesText"]);
  const RES = { available: true, candidate: { name: "Jane Doe" }, header: { mode: "account" }, contact: {}, work: [{ employer: "Acme", title: "Analyst", start: "2019-01", end: "2022-03" }], education: [], skills: [] };
  const openers = { "org / request": { cmpBusy: false, compareFrom: "request" }, "guest link": { guestBusy: false }, "account compare": { compareFrom: "acct" }, "paid, payment history": { myPaidBusy: false, compareFrom: "acct" } };
  for (const [name, state] of Object.entries(openers)) {
    const run = (atid) => {
      const p = new P(); p.state = {}; p.setState = (patch) => Object.assign(p.state, typeof patch === "function" ? patch(p.state) : patch); p.renderComparisonDocuments = () => {};
      const d = { content: { kind: "resume" }, assembled_at: "x", first_open: true, document: null, generated_document: atid ? { ...RES, atid } : RES };
      p.showCompare(state, d, { id: "1", label: "Candidate" });
      return { text: p.buildComparisonLines(p.state.compare.generatedDocument).map((l) => l.text), atidLine: p.comparisonAtidLine(p.state.compare.generatedDocument) };
    };
    const off = run(undefined), on = run("ATID-7K3M-Q9XP-2WD2");
    assert.equal(off.text.some((l) => /ATID|Applitrust ID/.test(l)), false, name + " off");
    assert.equal(off.atidLine, "", name + " off: no ATID line for the writer");
    assert.deepEqual(on.text, off.text, name + " on: the text lines are the same (BA: the ATID is drawn by the writer)");
    assert.equal(on.atidLine, "Applitrust ID: ATID-7K3M-Q9XP-2WD2", name);
  }
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
