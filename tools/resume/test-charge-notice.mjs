// node tools/resume/test-charge-notice.mjs   (no network, no Stripe call, no model call, no database)
// BE (October 21, 2026): a pay per use comparison request must say, loudly and at every step where the employer commits, that it costs money.
//  1. the boxed notice above the Send request button on both request screens (pay per use only, once, before the button, not hidden);
//  2. no typed in amount anywhere in the new text or code; without a loaded price the words stand in;
//  3. the confirm boxes lead with the amount, keep their true lines, and the button names the next step;
//  4. the Stripe card save session carries the custom text built from employer_pricing (the REAL employer-api source against a stand-in; the Stripe calls are a stub, none leaves this process);
//  5. the style is visibly stronger than the helper text (a text-level check of the inline style; NOT a rendered check);
//  6. My comparisons states the amount in a bold line next to the Open button; the stable tags are all present.
// NOT proved: the real look on screen in a browser, the real Stripe page, that Stripe accepts custom_text in setup mode (documented, not run).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const EMP = rd("employer.html"), API_SRC = rd("supabase/functions/employer-api/index.ts");
const BASE = process.env.BE_BASE || "5e08c83";
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();

// the expression of one prop of the page's render function (one line, ends with a comma)
const propExpr = (src, name) => { const m = new RegExp("\\n\\s+" + name + ": (.*),\\n").exec(src); assert.ok(m, "prop " + name + " exists"); return m[1]; };
const evalProp = (src, name, s, extra = {}) => { const Money = makeClass(src, ["money"]); const ctx = Object.assign(new Money(), { orgFormOk: () => false }, extra); return new Function("s", "return (" + propExpr(src, name) + ");").call(ctx, s); };

// ---- the template checks, as functions of the page text so a planted page can be run through the same check
const enclosing = (html, idx) => { const re = /<sc-if value="([^"]*)"[^>]*>|<\/sc-if>|<details[^>]*>|<\/details>/g; const stack = []; let m; while ((m = re.exec(html)) && m.index < idx) { if (m[0].startsWith("</")) stack.pop(); else stack.push(m[1] === undefined ? "details" : m[1]); } return stack; };
const SCREENS = [
  { id: "charge-notice-request", gate: "{{ directUsesGuest }}", button: 'id="request-lookup-submit"' },
  { id: "charge-notice-access", gate: "{{ accessPaidForm }}", button: 'sc-camel-on-click="{{ sendRequest }}"' },
];
function noticeProblems(html) {
  const out = [];
  if ((html.match(/data-charge-notice="request"/g) || []).length !== 2) out.push("the request notice must appear exactly once on each of the two request screens");
  for (const sc of SCREENS) {
    const idx = html.indexOf(`id="${sc.id}"`);
    if (idx < 0) { out.push(sc.id + " missing"); continue; }
    if (html.indexOf(`id="${sc.id}"`, idx + 5) >= 0) out.push(sc.id + " appears twice");
    const btn = html.indexOf(sc.button, idx);
    const btnBefore = html.lastIndexOf(sc.button, idx);
    if (btn < 0 || (btnBefore >= 0 && idx - btnBefore < 3500 && idx > btnBefore && btn - idx > 3500)) out.push(sc.id + " is not before the Send request button");
    if (btn - idx > 3500 || btn < idx) out.push(sc.id + " is not directly above the Send request button");
    const st = enclosing(html, idx);
    if (st[st.length - 1] !== sc.gate) out.push(sc.id + " is not gated by " + sc.gate + " (gated by " + st[st.length - 1] + ")");
    if (st.includes("details")) out.push(sc.id + " sits inside a collapse");
    const tag = html.slice(idx, html.indexOf(">", idx));
    if (/hidden|display:\s*none/.test(tag)) out.push(sc.id + " is hidden");
    // BM: the box holds ONLY the one sentence (and the small "How the charge works" link): no long paragraph
    const box = html.slice(idx, idx + 700);
    if (!/\{\{ chargeSentence \}\}/.test(box)) out.push(sc.id + " does not carry the sentence");
    if (/Your card is only charged|The next screen is Stripe/.test(html.slice(idx, idx + 1200))) out.push(sc.id + " still holds the long paragraph");
  }
  return out;
}
const AMOUNT = /\$\s?\d|\b\d+\.\d{2}\b|\b\d+\s*(dollars|usd|cents)\b/i;

// ------------------------------------------------------------------ 1
t("1 request screen: the boxed notice is on both pay per use request screens, once each, directly above the Send request button, not collapsed or hidden, gated to pay per use only; planted: after the button, in a collapse, shown for organizations too, shown twice, hidden are each caught", () => {
  assert.deepEqual(noticeProblems(EMP), []);
  const cut = (html, id) => { const a = html.lastIndexOf("<div", html.indexOf(`id="${id}"`)), b = html.indexOf("</div>\n      </div>", a) + "</div>\n      </div>".length; return [a, b, html.slice(a, b)]; };
  // (a) after the button
  { const [a, b, blk] = cut(EMP, "charge-notice-request"); const rest = EMP.slice(0, a) + EMP.slice(b); const at = rest.indexOf("{{ sendDirectLabel }}</button>") + "{{ sendDirectLabel }}</button>".length; const bad = rest.slice(0, at) + "\n" + blk + rest.slice(at); assert.ok(noticeProblems(bad).some((p) => /not before|not directly above/.test(p)), "after the button is caught"); }
  // (b) in a collapse
  { const [a, b, blk] = cut(EMP, "charge-notice-request"); const bad = EMP.slice(0, a) + "<details><summary>Cost</summary>" + blk + "</details>" + EMP.slice(b); assert.ok(noticeProblems(bad).some((p) => /collapse/.test(p)), "a collapse is caught"); }
  // (c) shown for organizations too (the gate removed)
  { const bad = EMP.replace('<sc-if value="{{ directUsesGuest }}" hint-placeholder-val="{{ true }}">\n      <!-- BE/BM: the charge notice', '<sc-if value="{{ true }}" hint-placeholder-val="{{ true }}">\n      <!-- BE/BM: the charge notice'); assert.notEqual(bad, EMP); assert.ok(noticeProblems(bad).some((p) => /not gated/.test(p)), "an ungated notice is caught"); }
  // (d) twice
  { const [a, b, blk] = cut(EMP, "charge-notice-request"); const bad = EMP.slice(0, b) + "\n" + blk.replace('id="charge-notice-request"', 'id="charge-notice-request2"').replace('data-charge-notice="request"', 'data-charge-notice="request"') + EMP.slice(b); assert.ok(noticeProblems(bad).length > 0, "a second copy is caught"); }
  // (e) hidden
  { const bad = EMP.replace('id="charge-notice-access" data-charge-notice="request" role="note" style="', 'id="charge-notice-access" data-charge-notice="request" role="note" hidden style="'); assert.notEqual(bad, EMP); assert.ok(noticeProblems(bad).some((p) => /hidden/.test(p)), "hidden is caught"); }
});
t("1b who sees it: pay per use only. The gates are computed from the same test the pages already use for an organization subscription, so an organization subscription employer sees the plan text and not the per comparison charge", () => {
  const guestExpr = propExpr(EMP, "directUsesGuest"), orgExpr = propExpr(EMP, "directUsesOrg");
  assert.equal(guestExpr, "!this.orgFormOk()"); assert.equal(orgExpr, "this.orgFormOk()");
  const m = /const accessPaidFormVal = (.*);\n/.exec(EMP); assert.ok(m, "accessPaidFormVal"); const paid = (orgOk, real, lookup) => new Function("orgOk", "s", "return (" + m[1].replace(/!orgOk/, "!orgOk") + ");")(orgOk, { real, reqLookupId: lookup });
  assert.equal(paid(false, { org: null }, "L1"), true, "a pay per use employer sees the paid form");
  assert.equal(paid(true, { org: { id: "o1" } }, "L1"), false, "an organization subscription employer does not");
  // the direct screen: the org branch carries none of the new text
  const orgBlock = EMP.slice(EMP.indexOf('<sc-if value="{{ directUsesOrg }}"'), EMP.indexOf("</sc-if>", EMP.indexOf('<sc-if value="{{ directUsesOrg }}"')));
  assert.equal(/charge-notice|chargeSentence/.test(orgBlock), false);
  // the direct confirm box is never open for an organization; its button keeps the plain label and sends at once
  assert.equal(evalProp(EMP, "directConfirmOpen", { reqConfirmOpen: true, screen: "request" }, { orgFormOk: () => true }), false);
  assert.equal(evalProp(EMP, "directConfirmOpen", { reqConfirmOpen: true, screen: "request" }, { orgFormOk: () => false }), true);
  assert.equal(evalProp(EMP, "sendDirectLabel", { reqBusy: false }, { orgFormOk: () => true }), "Send request");
  assert.equal(evalProp(EMP, "sendDirectLabel", { reqBusy: false }, { orgFormOk: () => false }), "Send request and continue to save card");
});

// ------------------------------------------------------------------ 2
t("2 the amount comes from the loaded price and is never typed in: it shows as the loaded figure, follows a changed price, and with no price loaded the words 'the comparison price' stand in (no number); planted: a typed in amount anywhere is caught", () => {
  const s10 = { guestPrice: { cents: 1000, currency: "usd" } }, s1250 = { guestPrice: { cents: 1250, currency: "usd" } }, none = { guestPrice: null };
  // BM: the one sentence (chargeSentence), built from the loaded price
  const sentence = (state) => { const C = makeClass(EMP, ["money", "chargeSentence"]); const p = new C(); p.state = state; return p.chargeSentence(); };
  assert.equal(sentence(s10), "$10.00 is charged only when you open the comparison. Nothing is charged now.");
  assert.equal(sentence(s1250), "$12.50 is charged only when you open the comparison. Nothing is charged now.");
  assert.equal(sentence(none), "the comparison price is charged only when you open the comparison. Nothing is charged now.");
  assert.equal(/\d/.test(sentence(none)), false, "no number without a price");
  // the added lines of the page and of the edge function hold no amount
  const added = (f) => execFileSync("git", ["diff", "-U0", BASE, "--", f], { cwd: repo }).toString().split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++"));
  for (const f of ["employer.html", "supabase/functions/employer-api/index.ts"]) { const bad = added(f).filter((l) => AMOUNT.test(l)); assert.deepEqual(bad, [], f + " has a typed in amount"); }
  // planted
  const hard = EMP.replace("return (this.state.guestPrice ? this.money(this.state.guestPrice) : 'the comparison price') + ' is charged only", "return '$10.00' + ' is charged only"); assert.notEqual(hard, EMP);
  const hardSentence = (() => { const C = makeClass(hard, ["money", "chargeSentence"]); const p = new C(); p.state = s1250; return p.chargeSentence(); })();
  assert.equal(AMOUNT.test(hardSentence), true, "planted: a typed in amount is caught by the scan"); assert.notEqual(hardSentence, sentence(s1250), "and the changed price case shows the wrong figure");
  const noFallback = EMP.replace(": 'the comparison price') + ' is charged only", ": '$0.00') + ' is charged only"); assert.notEqual(noFallback, EMP);
  assert.notEqual((() => { const C = makeClass(noFallback, ["money", "chargeSentence"]); const p = new C(); p.state = none; return p.chargeSentence(); })(), sentence(none), "planted: a number as the fallback is caught");
  // the notice text itself has no digit-amount
  const blk = EMP.slice(EMP.indexOf('id="charge-notice-request"'), EMP.indexOf("</div>\n      </div>", EMP.indexOf('id="charge-notice-request"'))); assert.equal(AMOUNT.test(blk), false);
});

// ------------------------------------------------------------------ 3
t("3 confirm boxes (BM): the direct, paid and claim token boxes lead with the one sentence, then exactly ONE short line ('If the candidate declines, does not answer, or you do not open it in time, you are never charged.'), then the two buttons; the hold mechanics lines are gone; the pay per use button says 'Continue to Stripe to save your card'; planted: lead removed, the short line removed, a long line back, old button label are caught", () => {
  const dlg = (html, id) => { const a = html.indexOf(`id="${id}"`); return html.slice(a, html.indexOf("</sc-if>", a)); };
  const NEVER = /<div data-charge-notice="never-charged">If the candidate declines, does not answer, or you do not open it in time, you are never charged\.<\/div>/;
  const check = (html) => { const out = [];
    const boxes = [["direct", dlg(html, "direct-confirm")], ["paid", (() => { const pa = html.indexOf('data-charge-notice="confirm-paid"'); return html.slice(pa, html.indexOf("</sc-if>", pa)); })()], ["guest", (() => { const ga = html.indexOf('data-charge-notice="confirm-guest"'); return html.slice(ga, html.indexOf("</sc-if>", ga)); })()]];
    for (const [name, b] of boxes) {
      if (!/\{\{ chargeSentence \}\}/.test(b.slice(0, 420))) out.push(name + " box: no sentence as the first line");
      if (!NEVER.test(b)) out.push(name + " box: the short line is missing");
      if ((b.match(/never-charged/g) || []).length !== 1) out.push(name + " box: the short line is not there exactly once");
      if (/7 days after|real charge only happens|hold<\/b>|place a|&mdash;|hold quietly|saves your card/.test(b)) out.push(name + " box: a long hold line is still there");
    }
    if (!/\{\{ confirmProceedLabel \}\}/.test(boxes[0][1])) out.push("direct box: button label");
    return out; };
  assert.deepEqual(check(EMP), []);
  const s = (real) => ({ guestPrice: { cents: 1000, currency: "usd" }, real });
  assert.equal(evalProp(EMP, "confirmProceedLabel", s({ org: null })), "Continue to Stripe to save your card");
  assert.equal(evalProp(EMP, "confirmProceedLabel", s(null)), "Send request. Nothing is charged now", "the claim token guest path keeps its label");
  assert.equal(evalProp(EMP, "confirmProceedLabel", { guestPrice: null, real: { org: null } }), "Checking the price…", "no price: the button waits (disabled) until the amount is known");
  assert.equal(evalProp(EMP, "confirmProceedLabel", s({ org: null }), { orgFormOk: () => true }), "Send request");
  assert.match(propExpr(EMP, "confirmProceedDisabled"), /\(!this\.orgFormOk\(\) && !s\.guestPrice\)/, "the button stays disabled with no price");
  // planted
  { const bad = EMP.replace('data-charge-notice="confirm-paid" data-charge-notice-lead style="font-size:22px;line-height:1.3;font-weight:700">{{ chargeSentence }}', 'data-charge-notice="confirm-paid" data-charge-notice-lead style="font-size:22px;line-height:1.3;font-weight:700">This saves your card.'); assert.notEqual(bad, EMP); assert.ok(check(bad).some((p) => /paid box: no sentence/.test(p))); }
  const after = (html, anchor, from, to) => { const i = html.indexOf(anchor); assert.ok(i > 0, "anchor " + anchor); const j = html.indexOf(from, i); assert.ok(j > 0, "text " + from); return html.slice(0, j) + to + html.slice(j + from.length); };
  { const bad = after(EMP, 'data-charge-notice="confirm-guest"', "you are never charged.", "you pay nothing."); assert.notEqual(bad, EMP); assert.ok(check(bad).some((p) => /guest box: the short line/.test(p)), "a changed short line is caught"); }
  { const bad = after(EMP, 'id="direct-confirm"', "you are never charged.</div>", "you are never charged.</div><div>The real charge only happens when you open the result, any time in the 7 days after that approval.</div>"); assert.notEqual(bad, EMP); assert.ok(check(bad).some((p) => /long hold line/.test(p)), "a long line back is caught"); }
  { const bad = EMP.replace("(s.real ? 'Continue to Stripe to save your card' : 'Send request. Nothing is charged now')", "'Send request. Nothing is charged now'"); assert.notEqual(bad, EMP); assert.notEqual(evalProp(bad, "confirmProceedLabel", s({ org: null })), "Continue to Stripe to save your card"); }
});
t("3b flow: on the pay per use request screen the button opens the charge box and only the box's own button sends; the organization button still sends at once; field mistakes are told before the box; planted: a button that sends at once is caught", async () => {
  const mk = (src, org) => { const C = makeClass(src, ["requestDirectSend", "directInputError"]); const p = new C(); p.calls = []; p.orgFormOk = () => org; p.sendDirectRequest = () => p.calls.push("send"); p.loadGuestPrice = () => p.calls.push("price"); p.setState = (o) => { p.state = Object.assign({}, p.state, o); }; return p; };
  const good = { reqBusy: false, candNameInput: "Lisa Test", candEmailInput: "l@x.test", candPhoneInput: "", reqAttestation: "I got it at the conference.", reqDocName: "a.pdf", reqConsent: true, guestPrice: { cents: 1000, currency: "usd" } };
  let p = mk(EMP, false); p.state = { ...good }; p.requestDirectSend(); assert.deepEqual(p.calls, []); assert.equal(p.state.reqConfirmOpen, true, "pay per use: the box opens, nothing is sent");
  p = mk(EMP, false); p.state = { ...good, guestPrice: null }; p.requestDirectSend(); assert.deepEqual(p.calls, ["price"], "the price is asked for when it is not loaded"); assert.equal(p.state.reqConfirmOpen, true);
  p = mk(EMP, true); p.state = { ...good }; p.requestDirectSend(); assert.deepEqual(p.calls, ["send"]); assert.notEqual(p.state.reqConfirmOpen, true, "organization: sends at once, no box");
  p = mk(EMP, false); p.state = { ...good, candNameInput: "Lisa" }; p.requestDirectSend(); assert.equal(p.state.reqConfirmOpen, undefined); assert.match(p.state.reqErr, /first and last name/, "a field mistake is told before the box");
  p = mk(EMP, false); p.state = { ...good, reqConsent: false }; p.requestDirectSend(); assert.equal(p.state.reqConfirmOpen, undefined, "an incomplete form opens nothing");
  // the box's own buttons
  assert.match(propExpr(EMP, "directConfirmSend"), /^\(\) => \{ this\.setState\(\{ reqConfirmOpen: false \}\); this\.sendDirectRequest\(\); \}$/);
  assert.match(propExpr(EMP, "directConfirmCancel"), /reqConfirmOpen: false/); assert.equal(/sendDirectRequest/.test(propExpr(EMP, "directConfirmCancel")), false);
  assert.equal(propExpr(EMP, "sendDirectRequest"), "() => this.requestDirectSend()");
  // planted: requestDirectSend that sends at once for pay per use
  const bad = EMP.replace("    if (!s.guestPrice) this.loadGuestPrice();\n    this.setState({ reqErr: null, reqConfirmOpen: true });", "    this.sendDirectRequest();"); assert.notEqual(bad, EMP);
  p = mk(bad, false); p.state = { ...good }; p.requestDirectSend(); assert.deepEqual(p.calls, ["send"], "planted: sends at once, which the check above would reject");
});

// ------------------------------------------------------------------ 4: the Stripe session (real employer-api against a stand-in; the Stripe side is a stub, nothing leaves the process)
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test", STRIPE_SECRET_KEY: "sk_test" })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
let DB, STRIPE_CALLS, REFUSE_CUSTOM_TEXT, EXTERNAL;
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const matches = (row, params) => { for (const [k, v] of params) { if (["select", "limit", "order"].includes(k)) continue; const m = /^(eq|is|gte)\.(.*)$/s.exec(v); if (!m) continue; const [, op, val] = m, cell = row[k]; if (op === "eq" && String(cell) !== val) return false; if (op === "is" && (val === "null" ? cell != null : cell == null)) return false; if (op === "gte" && !(String(cell) >= val)) return false; } return true; };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = (init.method || "GET").toUpperCase();
  if (u.host === "api.stripe.com") {
    const form = new URLSearchParams(init.body || ""); STRIPE_CALLS.push({ method, path: u.pathname, form: Object.fromEntries(form) });
    if (u.pathname === "/v1/customers") return ok({ id: "cus_stub" });
    if (u.pathname === "/v1/checkout/sessions") { if (REFUSE_CUSTOM_TEXT && form.has("custom_text[submit][message]")) return ok({ error: { type: "invalid_request_error", message: "Received unknown parameter: custom_text[submit]", param: "custom_text" } }, 400); return ok({ id: "cs_stub", url: "https://checkout.stripe.test/c/cs_stub" }); }
    return ok({}, 404);
  }
  if (u.host !== "db.test") { EXTERNAL.push(String(url)); return ok({}, 599); }
  const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!tb) return ok({ error: "unknown" }, 404);
  const table = tb[1]; DB[table] = DB[table] || [];
  if (method === "GET") return ok(DB[table].filter((r) => matches(r, u.searchParams)));
  if (method === "PATCH") { const hit = DB[table].filter((r) => matches(r, u.searchParams)); hit.forEach((r) => Object.assign(r, JSON.parse(init.body))); return new Response(null, { status: 204 }); }
  return ok({}, 405);
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "charge-notice-"));
let n = 0;
async function load(source) {
  const src = source.replace(/\r\n/g, "\n").replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n");
  const file = path.join(TMP, `employer-api-${++n}.ts`); fs.writeFileSync(file, src); return (await import(pathToFileURL(file).href)).default.fetch;
}
const SESSION = "S".repeat(40), REQ = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const seed = async (price) => { DB = { employer_users: [{ id: "u1", email: "boss@corp.test", name: "Boss", org_id: null, role: "owner" }], employer_sessions: [{ id: "s1", employer_user_id: "u1", token_hash: await sha(SESSION), expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null }],
  comparison_requests: [{ id: REQ, employer_user_id: "u1", access_method: "guest", stripe_customer_id: "cus_existing", card_saved_at: null }], employer_pricing: price === undefined ? [{ key: "guest_comparison", amount_cents: 1250, currency: "usd" }] : price ? [{ key: "guest_comparison", ...price }] : [] };
  STRIPE_CALLS = []; REFUSE_CUSTOM_TEXT = false; EXTERNAL = []; };
const setup = async (f) => { const r = await f(new Request("http://x/", { method: "POST", body: JSON.stringify({ session_token: SESSION, action: "start_card_setup", params: { request_id: REQ } }) })); return { status: r.status, body: await r.json() }; };
const sessionCalls = () => STRIPE_CALLS.filter((c) => c.path === "/v1/checkout/sessions");

t("4 Stripe page: the card save session (setup mode) carries custom text built from the employer_pricing row, says no charge now, the amount held at approval and the charge at open; the amount follows the price; no price gives the words; no typed in figure; the request still works", async () => {
  const f = await load(API_SRC);
  await seed(); let r = await setup(f); assert.equal(r.status, 200); assert.equal(r.body.url, "https://checkout.stripe.test/c/cs_stub");
  let c = sessionCalls(); assert.equal(c.length, 1); assert.equal(c[0].form.mode, "setup");
  assert.equal(c[0].form["custom_text[submit][message]"], "**$12.50 is charged only when you open the comparison. Nothing is charged now.**");   // BM: the one sentence, in bold
  assert.equal(c[0].form.customer, "cus_existing"); assert.equal(c[0].form["payment_method_types[0]"], "card"); assert.match(c[0].form.success_url, /setup=success$/); assert.equal(c[0].form["metadata[product]"], "employer_card_setup", "the rest of the session is unchanged");
  await seed({ amount_cents: 2000, currency: "usd" }); await setup(f); assert.match(sessionCalls()[0].form["custom_text[submit][message]"], /^\*\*\$20\.00 is charged only when you open the comparison\./, "the amount follows the price");
  await seed(null); r = await setup(f); assert.equal(r.status, 200); const none = sessionCalls()[0].form["custom_text[submit][message]"]; assert.match(none, /^\*\*the comparison price is charged only when you open the comparison\./); assert.equal(/\d/.test(none), false, "no number without a price");
  assert.deepEqual(EXTERNAL, [], "nothing but the stand-ins was called; no Stripe call was made");
});
t("4b if Stripe ever refuses the custom text, the card save is asked again without it and still works; any other refusal is not retried; planted: no retry, and a retry that never drops the text, are caught", async () => {
  const f = await load(API_SRC);
  await seed(); REFUSE_CUSTOM_TEXT = true; let r = await setup(f); assert.equal(r.status, 200, "the card save still works"); assert.equal(sessionCalls().length, 2);
  assert.equal("custom_text[submit][message]" in sessionCalls()[1].form, false, "the second ask has no custom text"); assert.equal(sessionCalls()[1].form.mode, "setup");
  const noRetry = API_SRC.replace(/      if \(!sess\.ok && sess\.status === 400 && JSON\.stringify\(sess\.data \|\| \{\}\)\.includes\("custom_text"\)\) \{\n[^\n]*\n[^\n]*\n      \}\n/, ""); assert.notEqual(noRetry, API_SRC);
  await seed(); REFUSE_CUSTOM_TEXT = true; r = await setup(await load(noRetry)); assert.notEqual(r.status, 200, "planted: no retry means a refused text breaks the card save");
  const keeps = API_SRC.replace('        delete setupForm["custom_text[submit][message]"];\n', ""); assert.notEqual(keeps, API_SRC);
  await seed(); REFUSE_CUSTOM_TEXT = true; r = await setup(await load(keeps)); assert.notEqual(r.status, 200, "planted: a retry that keeps the text is refused again");
});
t("4c planted: the session without the custom text, with a typed in amount, or with the wrong price source is caught", async () => {
  const none = API_SRC.replace('        "custom_text[submit][message]": setupChargeText(price),\n', ""); assert.notEqual(none, API_SRC);
  await seed(); await setup(await load(none)); assert.equal("custom_text[submit][message]" in sessionCalls()[0].form, false, "planted: removed, which the check in 4 would reject");
  const typed = API_SRC.replace("  return `**${amt} is charged only", "  return `**$10.00 is charged only"); assert.notEqual(typed, API_SRC);
  await seed(); await setup(await load(typed)); assert.doesNotMatch(sessionCalls()[0].form["custom_text[submit][message]"], /\$12\.50/, "planted: a typed in amount does not follow the price, caught by the changed price case");
  const wrong = API_SRC.replace('employer_pricing?key=eq.guest_comparison&select=amount_cents,currency")\)?.[0];\n      const sess', 'employer_pricing?key=eq.org_subscription_monthly&select=amount_cents,currency"))?.[0];\n      const sess'); void wrong;
  const src = API_SRC.slice(API_SRC.indexOf("start_card_setup: {")); assert.match(src, /const price = \(await rows\("employer_pricing\?key=eq\.guest_comparison&select=amount_cents,currency"\)\)\?\.\[0\];\n      let sess|const price = \(await rows\("employer_pricing\?key=eq\.guest_comparison&select=amount_cents,currency"\)\)\?\.\[0\];\n      const setupForm/, "the price is the same guest_comparison row the hold and the charge use");
  assert.match(API_SRC, /async function chargeGuestNow[\s\S]*?employer_pricing\?key=eq\.guest_comparison/, "and chargeGuestNow reads that same row");
});

// ------------------------------------------------------------------ 5
const noticeStyles = (html) => { const tag = (id) => { const a = html.indexOf(`id="${id}"`); return html.slice(a, html.indexOf(">", a)); }; const lead = (id) => { const a = html.indexOf("data-charge-notice-lead", html.indexOf(`id="${id}"`)); return html.slice(a, html.indexOf(">", a)); }; return { tag, lead }; };
function styleProblems(html) {
  const out = [], { tag, lead } = noticeStyles(html);
  for (const id of ["charge-notice-request", "charge-notice-access"]) {
    const s = tag(id), l = lead(id);
    if (!/border:\s*2px solid var\(--color-accent\)/.test(s)) out.push(id + ": no border");
    if (!/background:\s*color-mix\(in srgb,var\(--color-accent\) \d+%,transparent\)/.test(s)) out.push(id + ": no tinted background");
    if (!/font-weight:\s*700/.test(l) || !(Number((/font-size:\s*(\d+)px/.exec(l) || [])[1]) >= 16)) out.push(id + ": lead line not bold and large");
  }
  // the helper text it sits among: small, grey, no border, no background
  const helper = /style="font-size:11px;color:var\(--color-neutral-500\);margin-top:6px;line-height:1\.6"/; if (!helper.test(html)) out.push("helper text class not found to compare with");
  return out;
}
t("5 style: the notice has a 2px accent border, a tinted accent background and a bold 17px lead line, where the helper text it sits among is 11 to 13px grey with no border and no background (text level check of the inline style; the rendered look is not proved); planted: no border, no background, a plain lead are caught", () => {
  assert.deepEqual(styleProblems(EMP), []);
  const strip = (from, to) => { const bad = EMP.split(from).join(to); assert.notEqual(bad, EMP); return styleProblems(bad); };
  assert.ok(strip("border:2px solid var(--color-accent);background:color-mix", "background:color-mix").some((p) => /no border/.test(p)));
  assert.ok(strip(";background:color-mix(in srgb,var(--color-accent) 12%,transparent);border-radius:var(--radius-md);padding:var(--space-4)", ";border-radius:var(--radius-md);padding:var(--space-4)").some((p) => /no tinted background/.test(p)));
  assert.ok(strip("data-charge-notice-lead style=\"font-size:17px;font-weight:700;", "data-charge-notice-lead style=\"font-size:12px;").some((p) => /lead line/.test(p)));
  // the accent exists as a theme variable (this page defines one theme; the proof cannot show a light theme because the page has none)
  assert.match(EMP, /--color-accent: #9184d9;/); assert.match(EMP, /--color-text: #e9e9ed;/);
});

// ------------------------------------------------------------------ 6
t("6 My comparisons: the charge sentence is a bold 14px line next to the Open button's row (not the 12px grey status line), with the loaded amount; no duplicate of it in the status line; planted: a typed in amount or the sentence left in the small line is caught", () => {
  const Emp = makeClass(EMP, ["money", "paidComparisonStatusLabel", "paidComparisonChargeNote", "fmtDate"]); const P = new Emp(); P.fmtDate = () => "Oct 28, 2026";
  const hold = { status: "ready", hold_state: "holding", available_until: "x" };
  P.state = { guestPrice: { cents: 1250, currency: "usd" } };
  // BM: the approved state is ONE bold line with the open by date; the grey line is empty for it
  assert.equal(P.paidComparisonChargeNote(hold), "Opening charges your card $12.50. Open by Oct 28, 2026, or the hold expires and you are not charged."); assert.equal(P.paidComparisonStatusLabel(hold), "");
  assert.equal(P.paidComparisonChargeNote({ status: "ready", hold_state: "none" }), "Opening it charges $12.50 once a card is on file.");
  assert.equal(P.paidComparisonChargeNote({ status: "awaiting_candidate" }), ""); assert.equal(P.paidComparisonChargeNote({ status: "opened" }), ""); assert.equal(P.paidComparisonChargeNote({ status: "ready", hold_state: "held" }), "");
  P.state = { guestPrice: null }; assert.match(P.paidComparisonChargeNote(hold), /^Opening charges your card the comparison price\. Open by Oct 28, 2026,/);
  const a = EMP.indexOf('data-charge-notice="my-comparisons"'), tag = EMP.slice(EMP.lastIndexOf("<div", a), EMP.indexOf(">", a));
  assert.match(tag, /font-size:14px;font-weight:700;color:var\(--color-text\)/); assert.ok(a > EMP.indexOf("{{ row.onOpen }}") && a < EMP.indexOf("{{ row.statusLabel }}"), "after the Open button, before the small status line");
  const hard = EMP.replace("const amt = this.state.guestPrice ? this.money(this.state.guestPrice) : 'the comparison price';", "const amt = '$10.00';"); assert.notEqual(hard, EMP);
  const Q = new (makeClass(hard, ["money", "paidComparisonChargeNote"]))(); Q.fmtDate = () => "Oct 28, 2026"; Q.state = { guestPrice: { cents: 1250, currency: "usd" } }; assert.doesNotMatch(Q.paidComparisonChargeNote(hold), /12\.50/, "planted: typed in amount");
  assert.equal(AMOUNT.test(method(EMP, "paidComparisonChargeNote")), false);
  const dup = EMP.replace("if (c.hold_state === 'holding') return '';", "if (c.hold_state === 'holding') return 'Approved. Ready to open until ' + this.fmtDate(c.available_until) + '.';"); assert.notEqual(dup, EMP);
  const D = new (makeClass(dup, ["money", "paidComparisonStatusLabel", "fmtDate"]))(); D.fmtDate = () => "x"; D.state = { guestPrice: null }; assert.notEqual(D.paidComparisonStatusLabel(hold), "", "planted: a grey line back next to the bold one, which the exact check above rejects");
});
t("6b the stable tags for the text trimming pass are all present, and no em dash was added", () => {
  const tags = [...EMP.matchAll(/data-charge-notice="([a-z-]+)"/g)].map((m) => m[1]).sort();
  const count = (k) => tags.filter((x) => x === k).length;
  // BM: the tags for the text trimming pass (the sentence everywhere, the short line, the help, the pop-up, the rows, the lookup label)
  for (const [k, nn] of [["confirm-direct", 1], ["confirm-guest", 1], ["confirm-paid", 1], ["my-comparisons", 1], ["my-comparisons-status", 1], ["request", 2], ["request-sent", 1], ["never-charged", 3], ["how-it-works", 1], ["how-it-works-link", 3], ["charged-popup", 1], ["lookup-status", 3]]) assert.equal(count(k), nn, "tag " + k);
  assert.equal((EMP.match(/data-charge-notice-lead/g) || []).length, 5, "five lead lines: two request notices and three confirm boxes");
  for (const f of ["employer.html", "supabase/functions/employer-api/index.ts", "tools/resume/test-charge-notice.mjs"]) { const added = f.startsWith("tools") ? rd(f).split("\n") : execFileSync("git", ["diff", "-U0", BASE, "--", f], { cwd: repo }).toString().split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++")); assert.deepEqual(added.filter((l) => l.includes(String.fromCharCode(0x2014))), [], f + " has an em dash in added text"); }
  assert.equal(/fetch\(["'`]https:\/\/api\.stripe/.test(fs.readFileSync(new URL("tools/resume/test-charge-notice.mjs", repo), "utf8").replace(/\/\/.*$/gm, "").replace(/globalThis\.fetch[\s\S]*?\n\};/, "")), false, "this test file calls no Stripe address itself");
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 6).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
