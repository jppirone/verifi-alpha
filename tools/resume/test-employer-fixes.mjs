// node tools/resume/test-employer-fixes.mjs   (no network, no model call, no live database)
// BA (October 21, 2026), Part 5: the messages and screens. Real method text is cut out of employer.html and candidate.html (as the other page tests do) and the server rule is run from the real
// function source. Every guard is shown to catch a planted defect (a changed copy of the text held in memory; nothing on disk changes).
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const EMP = rd("employer.html"), CAND = rd("candidate.html"), API = rd("supabase/functions/employer-api/index.ts"), CMP = rd("supabase/functions/employer-comparison/index.ts");
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ 5b: when can a new request be made
const fnText = (src, name) => { const a = src.indexOf(`async function ${name}`), b = src.indexOf("\n}\n", a); return src.slice(a, b + 3); };
function blockEnds(src, rowsImpl) {
  const code = stripTypeScriptTypes(fnText(src, "openRequestBlockEnds")).replace("async function openRequestBlockEnds", "async function");
  return new Function("rows", "UUID", "return (" + code + ")")(rowsImpl, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
}
const ID = "00000000-0000-4000-8000-000000000001";
const ROW = (o) => ({ status: "approved", expires_at: "2026-10-24T10:00:00.000Z", snapshot_expires_at: "2026-10-28T15:01:23.254Z", first_delivered_at: null, view_window_ends_at: null, access_method: "guest", kind: "resume_comparison", ...o });
t("5b server: the date a new request becomes possible follows the real rule (pending: its 72 hour expiry; approved and unopened: the 7 day snapshot expiry; opened guest: the view window end; opened organization: 90 days for a resume comparison, 30 for a license report); anything else gives no date", async () => {
  for (const [name, src] of [["employer-api", API], ["employer-comparison", CMP]]) {
    const f = (row) => blockEnds(src, async () => (row === "throw" ? (() => { throw new Error("db"); })() : row === null ? [] : [row]));
    assert.equal(await f(ROW({ status: "pending" }))(ID), "2026-10-24T10:00:00.000Z", name);
    assert.equal(await f(ROW({}))(ID), "2026-10-28T15:01:23.254Z", name);
    assert.equal(await f(ROW({ first_delivered_at: "2026-10-21T15:09:15.828Z", view_window_ends_at: "2026-11-11T15:09:15.828Z" }))(ID), "2026-11-11T15:09:15.828Z", name);
    assert.equal(await f(ROW({ access_method: "org", first_delivered_at: "2026-10-21T00:00:00.000Z" }))(ID), "2027-01-19T00:00:00.000Z", name + " org resume: +90 days");
    assert.equal(await f(ROW({ access_method: "org", kind: "license_report", first_delivered_at: "2026-10-21T00:00:00.000Z" }))(ID), "2026-11-20T00:00:00.000Z", name + " org license: +30 days");
    for (const st of ["declined", "expired"]) assert.equal(await f(ROW({ status: st }))(ID), null, st);
    assert.equal(await f(null)(ID), null); assert.equal(await f("throw")(ID), null); assert.equal(await f(ROW({}))("not-an-id"), null); assert.equal(await f(ROW({}))(undefined), null);
  }
  assert.equal([...API.matchAll(/available_after: await openRequestBlockEnds\(res\.request_id\)/g)].length, 3, "all three already_open sites in employer-api");
  assert.equal([...CMP.matchAll(/available_after: await openRequestBlockEnds\(res\.request_id\)/g)].length, 1);
});
const Emp = () => makeClass(EMP, ["alreadyRequestedMsg", "money", "paidComparisonStatusLabel", "fmtDate"]);
t("5b page: the already-open message adds 'You can make a new request after [date].' from the server's date, adds nothing invented when there is none, and all four sites use it; planted: a hard-coded date or a missing site is caught", () => {
  const P = new (Emp())(); const base = "You already have a request open for this candidate.";
  assert.equal(P.alreadyRequestedMsg({ available_after: "2026-10-28T15:01:23.254Z" }, base), base + " You can make a new request after October 28, 2026.");
  for (const d of [undefined, null, {}, { available_after: null }, { available_after: "junk" }]) assert.equal(P.alreadyRequestedMsg(d, base), base, JSON.stringify(d));
  assert.equal([...EMP.matchAll(/code === 'already_requested' \? this\.alreadyRequestedMsg\(r\.data, '/g)].length, 4);
  assert.equal(/code === 'already_requested' \? '/.test(EMP), false, "no site keeps the plain message");
  const planted = EMP.replace("return base + ' You can make a new request after '", "return base + ' You can make a new request after October 1, 2026 and '"); assert.notEqual(planted, EMP);
  assert.notEqual(new (makeClass(planted, ["alreadyRequestedMsg"]))().alreadyRequestedMsg({ available_after: "2026-10-28T15:01:23.254Z" }, base), base + " You can make a new request after October 28, 2026.");
  const site = EMP.replace("code === 'already_requested' ? this.alreadyRequestedMsg(r.data, 'You already have a request open for this candidate.')", "code === 'already_requested' ? 'You already have a request open for this candidate.'"); assert.notEqual(site, EMP);
  assert.equal([...site.matchAll(/this\.alreadyRequestedMsg\(r\.data, '/g)].length, 3);
});

// ------------------------------------------------------------------ 5c: candidate approval screen
const CandC = (src = CAND) => makeClass(src, ["empItemSummaryText", "openEmpConfirm", "focusEmpConfirm"]);
t("5c(iii): the confirm text counts the items from the lists the server sends (and from plain totals): no more 'certification you have submitted ()'", () => {
  const P = new (CandC())();
  const lists = { total: 5, work: [{}, {}], education: [{}], certifications: [{}, {}] };
  assert.equal(P.empItemSummaryText(lists), "2 jobs, 1 education entry, 2 certifications and licenses");
  assert.equal(P.empItemSummaryText({ total: 3, work: { total: 1 }, education: { total: 0 }, certifications: { total: 2 } }), "1 job, 2 certifications and licenses");
  assert.equal(P.empItemSummaryText({ total: 1, work: [{}], education: [], certifications: [] }), "1 job");
  const old = CAND.replace("const n = (x) => (Array.isArray(x) ? x.length : (x && Number(x.total)) || 0);", "const n = (x) => (x && x.total) || 0;"); assert.notEqual(old, CAND);
  assert.equal(new (CandC(old))().empItemSummaryText(lists), "", "planted: the old reading gives the empty '()' on the server's real shape");
});
t("5c(i)(ii): Approve in the table row opens the Confirm box with any old banner cleared, then scrolls to it and focuses it (the visible one of the two layouts); planted: banner not cleared, no scroll, wrong wiring", () => {
  const run = (src) => {
    const P = new (CandC(src))(); const states = []; P.setState = (s) => states.push(s); P.state = {};
    const els = [{ offsetParent: null, scrollIntoView() { throw new Error("hidden layout touched"); }, focus() { throw new Error("hidden layout touched"); } }, { offsetParent: {}, scrolled: null, focused: null, scrollIntoView(o) { this.scrolled = o; }, focus(o) { this.focused = o; } }];
    globalThis.document = { querySelectorAll: () => els }; globalThis.requestAnimationFrame = (fn) => fn();
    try { P.openEmpConfirm("req-1"); } finally { delete globalThis.document; delete globalThis.requestAnimationFrame; }
    return { states, el: els[1] };
  };
  const ok = run(CAND);
  assert.deepEqual(ok.states, [{ empConfirmId: "req-1", empNotice: null }]);
  assert.deepEqual(ok.el.scrolled, { behavior: "smooth", block: "start" }); assert.deepEqual(ok.el.focused, { preventScroll: true });
  assert.equal([...CAND.matchAll(/data-emp-confirm="1" tabindex="-1"/g)].length, 2, "both layouts of the Confirm card");
  assert.match(CAND, /onApprove: \(\) => \(r\.kind === 'license_report' \? this\.startLicenseApprove\(r\.id\) : this\.openEmpConfirm\(r\.id\)\)/);
  assert.match(method(CAND, "startLicenseApprove"), /this\.focusEmpConfirm\(0\);/);
  const noBanner = CAND.replace("this.setState({ empConfirmId: id, empNotice: null });\n    this.focusEmpConfirm(0);", "this.setState({ empConfirmId: id });\n    this.focusEmpConfirm(0);"); assert.notEqual(noBanner, CAND);
  assert.notDeepEqual(run(noBanner).states, ok.states);
  const noScroll = CAND.replace("el.scrollIntoView({ behavior: 'smooth', block: 'start' }); ", ""); assert.notEqual(noScroll, CAND); assert.equal(run(noScroll).el.scrolled, null);
  const oldWire = CAND.replace("this.openEmpConfirm(r.id)),", "this.setState({ empConfirmId: r.id })),"); assert.notEqual(oldWire, CAND); assert.equal(/this\.openEmpConfirm\(r\.id\)\)/.test(oldWire), false);
});

// ------------------------------------------------------------------ 5d: an ATID on the update upload that is not the candidate's own
t("5d: the update (re-upload) review screen warns 'This file shows an ATID that is not yours. We ignored it.' only when the saved record says mismatch (from the upload answer or the resubmission's extraction record); match and empty show nothing; the ATID is never shown", () => {
  const P = new (makeClass(CAND, ["resubAtidIsMismatch"]))();
  const yes = [{ resubAtidWord: "mismatch" }, { resubAtidWord: "", resumeExtraction: { resume_document: { kind: "resubmission", atid_on_upload: "mismatch" } } }];
  const no = [{}, { resubAtidWord: "" }, { resubAtidWord: "match" }, { resumeExtraction: null }, { resumeExtraction: { resume_document: { kind: "resubmission", atid_on_upload: "match" } } }, { resumeExtraction: { resume_document: { kind: "resubmission" } } },
              { resumeExtraction: { resume_document: { kind: "initial", atid_on_upload: "mismatch" } } }];
  yes.forEach((s) => assert.equal(P.resubAtidIsMismatch(s), true, JSON.stringify(s))); no.forEach((s) => assert.equal(P.resubAtidIsMismatch(s), false, JSON.stringify(s)));
  const i = CAND.indexOf('id="resub-atid-note"'); assert.ok(i > 0); const block = CAND.slice(CAND.lastIndexOf("<sc-if", i), CAND.indexOf("</sc-if>", i) + 8);
  assert.match(block, /resubAtidMismatch/); assert.match(block, />This file shows an ATID that is not yours\. We ignored it\.</); assert.equal(/\{\{/.test(block.replace("{{ resubAtidMismatch }}", "").replace("{{ false }}", "")), false, "the note has no placeholder: no ATID can be shown");
  assert.ok(CAND.indexOf('id="resub-atid-note"') > CAND.indexOf('id="resub-review"'), "inside the review stage");
  assert.match(CAND, /resubAtidWord: data\.atid_on_upload === 'mismatch' \? 'mismatch' : ''/); assert.match(CAND, /resubAtidWord: '' \}\);\n    let res, data;/);
  const planted = CAND.replace("if (s.resubAtidWord === 'mismatch') return true;", "if (s.resubAtidWord) return true;"); assert.notEqual(planted, CAND);
  assert.equal(new (makeClass(planted, ["resubAtidIsMismatch"]))().resubAtidIsMismatch({ resubAtidWord: "match" }), true, "planted: shows for match, which the test above forbids");
});

// ------------------------------------------------------------------ 5e: the note under the switch
const NOTE = 'When this is on, an employer who types your name and your ATID can find your account (while "Let employers confirm I have an account here" is also on), and your ATID is shown on the comparison document that employer receives. You approve every request. Turn it off and your ATID does not work for lookup and is not shown to employers.';
t("5e: the note under 'Let employers use my ATID' says what the one switch covers (lookup by name plus ATID, and the ATID on the comparison document), in one block, and stays true to the code (lookup also needs Allow lookup)", () => {
  assert.equal([...CAND.matchAll(/When this is on, an employer who/g)].length, 1, "one block, not two");
  assert.ok(CAND.includes(NOTE)); assert.equal(/—/.test(NOTE), false);
  const ce = rd("supabase/functions/check-existence/index.ts"); assert.match(ce, /c\.discoverable === true/); assert.match(ce, /\(!atidMode \|\| c\.atid_employer_visible === true\)/);
  const cr = rd("supabase/functions/candidate-comparison-requests/index.ts"); assert.match(cr, /document_atid: documentAtid/);
  assert.equal(CAND.includes(NOTE.replace("types your name", "knows your name")), false);
});

// ------------------------------------------------------------------ 5f: price and charge lines
t("5f: 'My comparisons' says Clicking Open charges your card [amount] now, with the amount from the price the page loaded from employer_pricing (never typed in); without a loaded price it says 'the comparison price'; the request screen carries the price, the moment of charge and the corporate account pointer; the Stripe line is in the confirm box", () => {
  const P = new (Emp())(); P.fmtDate = (d) => "Oct 28, 2026";
  const c = { status: "ready", hold_state: "holding", available_until: "2026-10-28T00:00:00Z" };
  P.state = { guestPrice: { cents: 1000, currency: "usd" } };
  assert.equal(P.paidComparisonStatusLabel(c), "Approved. Ready to open until Oct 28, 2026. Clicking Open charges your card $10.00 now.");
  P.state = { guestPrice: { cents: 1250, currency: "usd" } }; assert.match(P.paidComparisonStatusLabel(c), /\$12\.50 now\.$/);
  P.state = { guestPrice: null }; assert.match(P.paidComparisonStatusLabel(c), /Clicking Open charges your card the comparison price now\.$/);
  assert.equal(/Opening it charges the hold now/.test(EMP), false);
  const addedMoney = [...method(EMP, "paidComparisonStatusLabel").matchAll(/\$\s?\d/g)]; assert.equal(addedMoney.length, 0, "no amount typed into the status text");
  const line = EMP.slice(EMP.indexOf('id="price-line-request"'), EMP.indexOf("</div>", EMP.indexOf('id="price-line-request"')));
  assert.match(line, /A one-off comparison costs \{\{ guestPriceLabel \}\}\./); assert.match(line, /Your card is only charged when you open the document, after the candidate approves\./); assert.match(line, /Organizations can set up a corporate account instead/); assert.equal(/\$\s?\d/.test(line), false);
  assert.ok(EMP.indexOf('id="price-line-request"') > EMP.indexOf('<sc-if value="{{ accessPaidForm }}"'), "inside the paid request form");
  assert.match(EMP, /Sending this request only saves your card for later; no hold is placed yet\. You enter your card details with Stripe, not on this site\./);
  assert.match(EMP, /if \(!this\.state\.guestPrice\) this\.loadGuestPrice\(\);   \/\/ BA, Part 5f/);
  assert.equal(/[—]/.test(line), false);
  const hard = EMP.replace("this.money(this.state.guestPrice) : 'the comparison price'", "'$10.00' : 'the comparison price'"); assert.notEqual(hard, EMP);
  const Q = new (makeClass(hard, ["paidComparisonStatusLabel", "money", "fmtDate"]))(); Q.fmtDate = () => "x"; Q.state = { guestPrice: { cents: 1250, currency: "usd" } };
  assert.doesNotMatch(Q.paidComparisonStatusLabel(c), /\$12\.50/, "planted: a typed-in amount is caught by the changed-price case above");
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e?.stack ?? e).split("\n").slice(0, 7).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
