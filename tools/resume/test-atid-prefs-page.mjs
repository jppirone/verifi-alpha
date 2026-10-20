// node tools/resume/test-atid-prefs-page.mjs   (no network, no model call; reads candidate.html)
// ATID stored choices (prompt AU, October 19, 2026): the three export choices and the employer switch are stored on the account and held in ONE place in the page (this.state),
// loaded from the profile response and written only after a successful save. The methods and the render mapping are cut out of candidate.html as written and run against stubs.
// NOT proved: a real browser (the template engine, focus, the real re-render timing), the real server, Supabase.
import assert from "node:assert/strict";
import fs from "node:fs";

const repo = new URL("../../", import.meta.url);
const CAND = fs.readFileSync(new URL("candidate.html", repo), "utf8").replace(/\r\n/g, "\n");
function method(src, name) {
  let start = src.indexOf("\n  " + name + "(");
  if (start < 0) start = src.indexOf("\n  async " + name + "(");
  if (start < 0) return null;
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start + 1, end + 4);
}
const P = new Function("return class P { " + ["saveAtidFlag", "atidPdfSwitchChanged", "atidPdfOpts", "atidDisplayForm", "atidIsStored", "toggleAtidEmployerVisible", "atidUploadNoteText"].map((n) => method(CAND, n)).join("\n") + " }")();

const FLAGS = [
  { key: "atidExportPdfLine", server: "atid_export_pdf_line", where: "pdf", pdf: true },
  { key: "atidExportPdfHidden", server: "atid_export_pdf_hidden", where: "pdf", pdf: true },
  { key: "atidExportJson", server: "atid_export_json", where: "json", pdf: false },
  { key: "atidEmployerVisible", server: "atid_employer_visible", where: "card", pdf: false },
];
const INITIAL = () => ({ atid: "ATID7K3MQ9XP2WD2", resumeCandidateId: "cid", accountTab: "profile", atidEmployerVisible: false, atidExportPdfLine: false, atidExportPdfHidden: false, atidExportJson: false, atidFlagSaving: false, atidFlagError: null, atidFlagErrorWhere: "" });

// a page instance with a stub server: reply(serverKey, value, body) decides the answer; `server` is the account's stored row
function page(state = {}, opts = {}) {
  const p = new P();
  p.state = { ...INITIAL(), ...state };
  p.account = { atid_export_pdf_line: false, atid_export_pdf_hidden: false, atid_export_json: false, atid_employer_visible: false, ...(opts.account || {}) };
  p.requests = []; p.redraws = 0; p.storageTouches = 0;
  p.setState = (patch, cb) => { Object.assign(p.state, typeof patch === "function" ? patch(p.state) : patch); if (cb) cb(); };
  p.SUPABASE_FN_URL = "http://fn.test"; p.SUPABASE_ANON_KEY = "anon"; p.candidateSessionToken = () => "tok";
  p._pdfSrc = { delivered: {}, editor: {} };
  p.renderPdfPreviewFrom = () => { p.redraws++; };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); p.requests.push({ url, body });
    if (opts.fail === "throw") throw new Error("net");
    if (opts.fail === "http") return { ok: false, json: async () => ({ ok: false }) };
    if (opts.fail === "notok") return { ok: true, json: async () => ({ ok: false }) };
    if (opts.fail === "badshape") return { ok: true, json: async () => ({ ok: true }) };
    for (const f of FLAGS) if (f.server in body) p.account[f.server] = body[f.server];
    return { ok: true, json: async () => ({ ok: true, ...p.account }) };
  };
  return p;
}

// the render mapping, cut out of candidate.html: what each box is told to show on every render
const BLOCK = CAND.slice(CAND.indexOf("      hasAtid: !!s.atid,"), CAND.indexOf("      headerPrefsSaveError: s.headerPrefsSaveError,"));
const EMPLOYER_LINES = [...CAND.matchAll(/^      (atidEmployerVisible: s\.atidEmployerVisible|atidEmployerSaving: s\.atidFlagSaving),$/gm)].map((m) => m[1]).join(",\n");
const renderOf = (instance, s) => new Function("s", "return {" + BLOCK.trim().replace(/,$/, "") + ",\n" + EMPLOYER_LINES + "}").call(instance, s);
// the profile-to-state mapping applySession uses for the four choices, cut out of candidate.html
const MAP = [...CAND.matchAll(/^      (atid(?:EmployerVisible|ExportPdfLine|ExportPdfHidden|ExportJson): \(profile && typeof profile\.[a-z_]+ === 'boolean'\) \? profile\.[a-z_]+ : this\.state\.[A-Za-z]+),$/gm)].map((m) => m[1]);
const applyProfile = (state, profile) => ({ ...state, ...new Function("profile", "return {" + MAP.join(",\n").replace(/this\.state/g, "(" + JSON.stringify(state) + ")") + "}")(profile) });

const tests = []; const t = (n, f) => tests.push([n, f]);

t("the render mapping and the profile mapping were found in the page for all four choices", () => {
  assert.equal(MAP.length, 4, "four mapping lines");
  for (const f of FLAGS) assert.ok(MAP.some((m) => m.startsWith(f.key + ":")), f.key);
  const r = renderOf(new P(), { ...INITIAL(), atidExportJson: true });
  assert.equal(r.atidExportJson, true); assert.equal(r.atidExportPdfLine, false);
});
for (const f of FLAGS) {
  t(`${f.key}: turned on and saved, it keeps its value across 6 forced re-renders, tab switches and a PDF preview redraw (state is the only copy; nothing reads the DOM)`, async () => {
    const p = page();
    await p.saveAtidFlag(f.key, f.server, true, f.where);
    assert.equal(p.state[f.key], true); assert.equal(p.account[f.server], true);
    for (let i = 0; i < 6; i++) {
      p.setState({ accountTab: ["views", "profile", "verification", "customization", "activity", "profile"][i] });   // a tab switch
      p.setState({ somethingElse: i });                                                                              // any unrelated re-render
      p.atidPdfSwitchChanged();                                                                                      // a PDF preview redraw
      assert.equal(renderOf(p, p.state)[f.key], true, f.key + " after round " + i);
    }
    assert.equal(p.requests.length, 1, "no extra saves from re-rendering");
    // turned off again, same
    await p.saveAtidFlag(f.key, f.server, false, f.where);
    for (let i = 0; i < 6; i++) { p.setState({ accountTab: i % 2 ? "views" : "profile" }); assert.equal(renderOf(p, p.state)[f.key], false); }
    assert.equal(p.account[f.server], false);
  });
  t(`${f.key}: a simulated reload and a simulated fresh sign-in show the saved value, true and false`, () => {
    for (const saved of [true, false]) {
      // reload: a new page starts all off, the profile response says what the account holds
      const reloaded = applyProfile(INITIAL(), { [f.server]: saved });
      assert.equal(reloaded[f.key], saved);
      assert.equal(renderOf(new P(), reloaded)[f.key], saved);
      // sign out then sign in as someone else: the state is wiped to the initial off, then the new profile decides
      const signedOut = INITIAL();
      assert.equal(signedOut[f.key], false);
      assert.equal(applyProfile(signedOut, { [f.server]: saved })[f.key], saved);
      // a profile that does not carry the field keeps what the page has (never invents a value)
      assert.equal(applyProfile({ ...INITIAL(), [f.key]: saved }, {})[f.key], saved);
      for (const junk of ["true", 1, null, undefined]) assert.equal(applyProfile({ ...INITIAL(), [f.key]: saved }, { [f.server]: junk })[f.key], saved, JSON.stringify(junk));
    }
  });
  for (const fail of ["http", "throw", "notok", "badshape"]) {
    t(`${f.key}: a failed save (${fail}) puts the box back and shows the short message, whether it was off or on`, async () => {
      for (const start of [false, true]) {
        const p = page({ [f.key]: start }, { fail });
        await p.saveAtidFlag(f.key, f.server, !start, f.where);
        assert.equal(p.state[f.key], start, "back to what it was");
        assert.equal(p.state.atidFlagError, "We couldn't save that change, so it's back to what it was. Please try again.");
        assert.equal(p.state.atidFlagErrorWhere, f.where); assert.equal(p.state.atidFlagSaving, false);
        assert.equal(renderOf(p, p.state)[f.key], start);
        assert.equal(p.redraws, 0, "no preview redraw for a failed save");
      }
    });
  }
  t(`${f.key}: a successful save updates the in-memory state at once, so another tab and back shows it with no reload (and no second request)`, async () => {
    const p = page();
    await p.saveAtidFlag(f.key, f.server, true, f.where);
    p.setState({ accountTab: "views" }); p.setState({ accountTab: "profile" });
    assert.equal(renderOf(p, p.state)[f.key], true); assert.equal(p.requests.length, 1);
    assert.deepEqual(p.requests[0].body, { session_token: "tok", candidate_id: "cid", [f.server]: true }, "only this one flag is sent");
    assert.equal(p.requests[0].url, "http://fn.test/set-atid-preferences");
    assert.equal(p.redraws, f.pdf ? 1 : 0, f.pdf ? "a changed PDF choice redraws the preview once" : "other choices do not redraw it");
    assert.equal(p.state.atidFlagError, null);
  });
}
t("the server's answer wins: if it says a different value than was asked, the box shows the server's value", async () => {
  const p = page(); globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, atid_export_json: false }) });
  await p.saveAtidFlag("atidExportJson", "atid_export_json", true, "json");
  assert.equal(p.state.atidExportJson, false);
});
t("while one choice is saving a second change is refused with the same message and the box goes back (the boxes are also disabled while saving)", async () => {
  const p = page({ atidFlagSaving: true });
  await p.saveAtidFlag("atidExportJson", "atid_export_json", true, "json");
  assert.equal(p.state.atidExportJson, false); assert.equal(p.requests.length, 0); assert.match(p.state.atidFlagError, /couldn't save/);
  assert.ok(renderOf(p, { ...INITIAL(), atidFlagSaving: true }).atidFlagSaving === true);
  const q = page({ resumeCandidateId: "" }); await q.saveAtidFlag("atidEmployerVisible", "atid_employer_visible", true, "card");
  assert.equal(q.state.atidEmployerVisible, false); assert.equal(q.requests.length, 0);
});
t("the four choices are independent: saving one never sends or changes another", async () => {
  const p = page({}, { account: { atid_export_json: true } }); p.state.atidExportJson = true;
  await p.saveAtidFlag("atidExportPdfLine", "atid_export_pdf_line", true, "pdf");
  assert.deepEqual(Object.keys(p.requests[0].body).sort(), ["atid_export_pdf_line", "candidate_id", "session_token"]);
  assert.equal(p.state.atidExportJson, true); assert.equal(p.state.atidExportPdfHidden, false); assert.equal(p.state.atidEmployerVisible, false);
});
t("the PDF options follow the stored choices: all off gives {} (the PDF is byte for byte the old one), line and hidden each add their own part", async () => {
  const DISP = "ATID-7K3M-Q9XP-2WD2";
  assert.deepEqual(page().atidPdfOpts(), {});
  const a = page(); await a.saveAtidFlag("atidExportPdfLine", "atid_export_pdf_line", true, "pdf"); assert.deepEqual(a.atidPdfOpts(), { atidLine: DISP });
  const b = page(); await b.saveAtidFlag("atidExportPdfHidden", "atid_export_pdf_hidden", true, "pdf"); assert.deepEqual(b.atidPdfOpts(), { atidMeta: DISP });
  assert.deepEqual(page({ atid: "" , atidExportPdfLine: true }).atidPdfOpts(), {});
});
t("new accounts and existing accounts start with all four off: the initial page state and every session-less default are false", () => {
  assert.ok(CAND.includes("\n    atidEmployerVisible: false,\n    atidExportPdfLine: false, atidExportPdfHidden: false, atidExportJson: false,\n    atidFlagSaving: false, atidFlagError: null, atidFlagErrorWhere: '',"));
});
t("no localStorage, sessionStorage or cookie is touched by any of it: not by the code (static) and not when the saves run (every storage call would throw)", async () => {
  const code = ["saveAtidFlag", "atidPdfSwitchChanged", "atidPdfOpts", "toggleAtidEmployerVisible"].map((n) => method(CAND, n)).join("\n");
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(code), false);
  assert.equal(/(localStorage|sessionStorage|document\.cookie)[^\n]*(atidExport|atidEmployer|atid_export|atid_employer)|(atidExport|atidEmployer|atid_export|atid_employer)[^\n]*(localStorage|sessionStorage|document\.cookie)/.test(CAND), false, "nowhere in the page are they written near these names");
  const boom = new Proxy({}, { get() { throw new Error("storage touched"); }, set() { throw new Error("storage touched"); } });
  globalThis.localStorage = boom; globalThis.sessionStorage = boom; globalThis.document = { get cookie() { throw new Error("cookie touched"); }, set cookie(v) { throw new Error("cookie touched"); } };
  try { for (const f of FLAGS) { const p = page(); await p.saveAtidFlag(f.key, f.server, true, f.where); await p.saveAtidFlag(f.key, f.server, false, f.where); p.atidPdfOpts(); } } finally { delete globalThis.localStorage; delete globalThis.sessionStorage; delete globalThis.document; }
});
t("nothing reads a box back out of the DOM: the old DOM reads are gone, and the JSON export reads the stored choice from state", () => {
  assert.equal(/atidSwitchOn|getElementById\('atid-/.test(CAND), false);
  assert.ok(CAND.includes("const wantAtid = !!s.atidExportJson;"));
});
t("the screen: each box is bound to saved state and disabled only while a save runs; the saved line and the short error sit with each group; no em dash and no 'verified' in the new copy", () => {
  const boxes = {
    "atid-json-switch": ["atidExportJson", "toggleAtidExportJson"], "atid-pdf-line-switch": ["atidExportPdfLine", "toggleAtidExportPdfLine"],
    "atid-pdf-meta-switch": ["atidExportPdfHidden", "toggleAtidExportPdfHidden"], "atid-employer-visible-switch": ["atidEmployerVisible", "toggleAtidEmployerVisible"],
  };
  for (const [id, [st, tg]] of Object.entries(boxes)) {
    const tag = new RegExp(`<input type="checkbox" id="${id}"[^>]*>`).exec(CAND)[0];
    assert.ok(tag.includes(`checked="{{ ${st} }}"`) && tag.includes(`sc-camel-on-change="{{ ${tg} }}"`) && /disabled="\{\{ (atidFlagSaving|atidEmployerSaving) \}\}"/.test(tag), id);
  }
  assert.equal([...CAND.matchAll(/Your choices here are saved to your account\./g)].length, 2);
  for (const id of ["atid-json-error", "atid-pdf-error", "atid-card-error"]) assert.ok(CAND.includes(`id="${id}"`), id);
  const newCopy = ["Your choices here are saved to your account.", "We couldn't save that change, so it's back to what it was. Please try again."];
  for (const s of newCopy) { assert.equal(s.includes("—"), false); assert.equal(/verified/i.test(s), false); }
  assert.ok(CAND.includes("An ATID printed on a resume can be copied by anyone"), "the existing note is kept");
});
t("the upload note: own ATID gives the match note, anything else the one warning, nothing gives nothing; exact words, no em dash, no 'verified'", () => {
  const p = new P();
  const note = (w) => p.atidUploadNoteText(w === undefined ? null : { resume_document: { atid_on_upload: w } });
  assert.equal(note("match"), "We found your ATID on this resume. We keep using the one already on your account, so it was left out of your content.");
  assert.equal(note("mismatch"), "The ATID on this resume is not the one on your account. We ignore ATIDs on uploads and keep using yours, so nothing was changed.");
  for (const w of [null, undefined, "", "none", "ATID-7K3M-Q9XP-2WD2", 5]) assert.equal(note(w), "", JSON.stringify(w));
  assert.equal(p.atidUploadNoteText(null), ""); assert.equal(p.atidUploadNoteText({}), "");
  for (const s of [note("match"), note("mismatch")]) { assert.equal(s.includes("—"), false); assert.equal(/verified/i.test(s), false); }
  assert.ok(CAND.includes('<sc-if value="{{ hasAtidUploadNote }}"') && CAND.includes('id="atid-upload-note"'));
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
