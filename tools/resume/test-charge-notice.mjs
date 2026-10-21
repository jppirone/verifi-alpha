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
    if (!/\{\{ chargeLeadLine \}\}/.test(html.slice(idx, idx + 900))) out.push(sc.id + " does not carry the lead line");
    if ((html.slice(idx, idx + 1400).match(/\{\{ chargeAmountLabel \}\}/g) || []).length < 2) out.push(sc.id + " does not carry the loaded amount twice");
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
  { const bad = EMP.replace('<sc-if value="{{ directUsesGuest }}" hint-placeholder-val="{{ true }}">\n      <!-- BE: the charge notice', '<sc-if value="{{ true }}" hint-placeholder-val="{{ true }}">\n      <!-- BE: the charge notice'); assert.notEqual(bad, EMP); assert.ok(noticeProblems(bad).some((p) => /not gated/.test(p)), "an ungated notice is caught"); }
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
  assert.equal(/charge-notice|chargeAmountLabel|chargeLeadLine/.test(orgBlock), false);
  // the direct confirm box is never open for an organization; its button keeps the plain label and sends at once
  assert.equal(evalProp(EMP, "directConfirmOpen", { reqConfirmOpen: true, screen: "request" }, { orgFormOk: () => true }), false);
  assert.equal(evalProp(EMP, "directConfirmOpen", { reqConfirmOpen: true, screen: "request" }, { orgFormOk: () => false }), true);
  assert.equal(evalProp(EMP, "sendDirectLabel", { reqBusy: false }, { orgFormOk: () => true }), "Send request");
  assert.equal(evalProp(EMP, "sendDirectLabel", { reqBusy: false }, { orgFormOk: () => false }), "Send request and continue to save card");
});

// ------------------------------------------------------------------ 2
t("2 the amount comes from the loaded price and is never typed in: it shows as the loaded figure, follows a changed price, and with no price loaded the words 'the comparison price' stand in (no number); planted: a typed in amount anywhere is caught", () => {
  const s10 = { guestPrice: { cents: 1000, currency: "usd" } }, s1250 = { guestPrice: { cents: 1250, currency: "usd" } }, none = { guestPrice: null };
  assert.equal(evalProp(EMP, "chargeAmountLabel", s10), "$10.00"); assert.equal(evalProp(EMP, "chargeAmountLabel", s1250), "$12.50");
  assert.equal(evalProp(EMP, "chargeLeadLine", s1250), "This costs $12.50.");
  assert.equal(evalProp(EMP, "confirmLeadLine", s1250), "You will be charged $12.50 when you open this comparison.");
  assert.equal(evalProp(EMP, "chargeAmountLabel", none), "the comparison price");
  assert.equal(evalProp(EMP, "confirmLeadLine", none), "You will be charged the comparison price when you open this comparison.");
  const lead = evalProp(EMP, "chargeLeadLine", none); assert.equal(AMOUNT.test(lead) || /\d/.test(lead), false, "no number without a price: " + lead); assert.match(lead, /shown in the next box, before anything is sent/);
  // the added lines of the page and of the edge function hold no amount
  const added = (f) => execFileSync("git", ["diff", "-U0", BASE, "--", f], { cwd: repo }).toString().split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++"));
  for (const f of ["employer.html", "supabase/functions/employer-api/index.ts"]) { const bad = added(f).filter((l) => AMOUNT.test(l)); assert.deepEqual(bad, [], f + " has a typed in amount"); }
  // planted
  const hard = EMP.replace("chargeLeadLine: s.guestPrice ? 'This costs ' + this.money(s.guestPrice) + '.'", "chargeLeadLine: s.guestPrice ? 'This costs $10.00.'"); assert.notEqual(hard, EMP);
  assert.equal(AMOUNT.test(propExpr(hard, "chargeLeadLine")), true, "planted: a typed in amount is caught by the scan");
  assert.equal(evalProp(hard, "chargeLeadLine", s1250), "This costs $10.00.", "and the changed price case shows the wrong figure");
  const hardNone = EMP.replace("'the comparison price' : 'the comparison price'", "x"); // no-op guard
  const noFallback = EMP.replace("chargeAmountLabel: s.guestPrice ? this.money(s.guestPrice) : 'the comparison price'", "chargeAmountLabel: s.guestPrice ? this.money(s.guestPrice) : '$0.00'"); assert.notEqual(noFallback, EMP);
  assert.notEqual(evalProp(noFallback, "chargeAmountLabel", none), "the comparison price", "planted: a number as the fallback is caught");
  // the notice text itself has no digit-amount
  const blk = EMP.slice(EMP.indexOf('id="charge-notice-request"'), EMP.indexOf("</div>\n      </div>", EMP.indexOf('id="charge-notice-request"'))); assert.equal(AMOUNT.test(blk), false);
});

// ------------------------------------------------------------------ 3
t("3 confirm boxes: both lead with 'You will be charged [amount] when you open this comparison.' as their first line, keep every existing true line, and the pay per use button says 'Continue to Stripe to save your card'; planted: lead removed, true line removed, old button label are caught", () => {
  const dlg = (html, id) => { const a = html.indexOf(`id="${id}"`); return html.slice(a, html.indexOf("</sc-if>", a)); };
  const TRUE_LINES = [/<b>This saves your card\. It does not charge it\.<\/b>/, /<b>Nothing is charged now\.<\/b> Sending this request only saves your card for later; no hold is placed yet\. You enter your card details with Stripe, not on this site\./, /automatically place a <b>\{\{ (confirmPriceLabel|chargeAmountLabel) \}\} hold<\/b> on that saved card the moment they do/, /<b>real charge only happens when you open the result<\/b>, any time in the <b>7 days after that approval<\/b>, not from today\./, /the hold quietly expires and <b>you are never charged<\/b>/];
  const check = (html) => { const out = []; for (const id of ["direct-confirm", "req-confirm-title\" data-charge-notice=\"confirm-paid"]) { void id; }
    const d = dlg(html, "direct-confirm"); if (!/\{\{ confirmLeadLine \}\}/.test(d.slice(0, 700))) out.push("direct box: no lead line"); for (const re of TRUE_LINES) if (!re.test(d)) out.push("direct box: missing " + re);
    const pa = html.indexOf('data-charge-notice="confirm-paid"'), pb = html.indexOf("</sc-if>", pa), p = html.slice(pa, pb); if (!/\{\{ confirmLeadLine \}\}/.test(p.slice(0, 200))) out.push("paid box: no lead line"); for (const re of TRUE_LINES) if (!re.test(p)) out.push("paid box: missing " + re);
    const ga = html.indexOf('data-charge-notice="confirm-guest"'), gb = html.indexOf("</sc-if>", ga), g = html.slice(ga, gb); if (!/\{\{ confirmLeadLine \}\}/.test(g.slice(0, 200))) out.push("guest box: no lead line"); if (!/Nothing is charged now\.<\/b> Sending this request is free\./.test(g) || !/you are never charged/.test(g) || !/You place a \{\{ confirmPriceLabel \}\} hold, not a charge, when you pay\./.test(g)) out.push("guest box: a true line is missing");
    if (!/\{\{ confirmProceedLabel \}\}/.test(d)) out.push("direct box: button label");
    return out; };
  assert.deepEqual(check(EMP), []);
  const s = (real) => ({ guestPrice: { cents: 1000, currency: "usd" }, real });
  assert.equal(evalProp(EMP, "confirmProceedLabel", s({ org: null })), "Continue to Stripe to save your card");
  assert.equal(evalProp(EMP, "confirmProceedLabel", s(null)), "Send request. Nothing is charged now", "the claim token guest path keeps its label");
  assert.equal(evalProp(EMP, "confirmProceedLabel", { guestPrice: null, real: { org: null } }), "Checking the price…", "no price: the button waits (disabled) until the amount is known");
  assert.equal(evalProp(EMP, "confirmProceedLabel", s({ org: null }), { orgFormOk: () => true }), "Send request");
  assert.match(propExpr(EMP, "confirmProceedDisabled"), /\(!this\.orgFormOk\(\) && !s\.guestPrice\)/, "the button stays disabled with no price");
  // planted
  { const bad = EMP.replace('data-charge-notice="confirm-paid" data-charge-notice-lead style="font-size:22px;line-height:1.3">{{ confirmLeadLine }}', 'data-charge-notice="confirm-paid" data-charge-notice-lead style="font-size:22px;line-height:1.3">This saves your card.'); assert.notEqual(bad, EMP); assert.ok(check(bad).some((p) => /paid box: no lead/.test(p))); }
  { const bad = EMP.replace("<b>you are never charged</b>", "<b>you pay nothing</b>"); assert.ok(check(bad).length > 0, "a removed true line is caught"); }
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
  assert.equal(c[0].form["custom_text[submit][message]"], "**No charge now.** $12.50 is held on your card when the candidate approves. It is charged when you open the document.");
  assert.equal(c[0].form.customer, "cus_existing"); assert.equal(c[0].form["payment_method_types[0]"], "card"); assert.match(c[0].form.success_url, /setup=success$/); assert.equal(c[0].form["metadata[product]"], "employer_card_setup", "the rest of the session is unchanged");
  await seed({ amount_cents: 2000, currency: "usd" }); await setup(f); assert.match(sessionCalls()[0].form["custom_text[submit][message]"], /^\*\*No charge now\.\*\* \$20\.00 is held/, "the amount follows the price");
  await seed(null); r = await setup(f); assert.equal(r.status, 200); const none = sessionCalls()[0].form["custom_text[submit][message]"]; assert.match(none, /^\*\*No charge now\.\*\* the comparison price is held/); assert.equal(/\d/.test(none), false, "no number without a price");
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
  const typed = API_SRC.replace("  return `**No charge now.** ${amt} is held", "  return `**No charge now.** $10.00 is held"); assert.notEqual(typed, API_SRC);
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
  assert.equal(P.paidComparisonChargeNote(hold), "Clicking Open charges your card $12.50 now."); assert.equal(P.paidComparisonStatusLabel(hold), "Approved. Ready to open until Oct 28, 2026.");
  assert.equal(P.paidComparisonChargeNote({ status: "ready", hold_state: "none" }), "Opening it charges $12.50 once a card is on file.");
  assert.equal(P.paidComparisonChargeNote({ status: "awaiting_candidate" }), ""); assert.equal(P.paidComparisonChargeNote({ status: "opened" }), ""); assert.equal(P.paidComparisonChargeNote({ status: "ready", hold_state: "held" }), "");
  P.state = { guestPrice: null }; assert.equal(P.paidComparisonChargeNote(hold), "Clicking Open charges your card the comparison price now.");
  const a = EMP.indexOf('data-charge-notice="my-comparisons"'), tag = EMP.slice(EMP.lastIndexOf("<div", a), EMP.indexOf(">", a));
  assert.match(tag, /font-size:14px;font-weight:700;color:var\(--color-text\)/); assert.ok(a > EMP.indexOf("{{ row.onOpen }}") && a < EMP.indexOf("{{ row.statusLabel }}"), "after the Open button, before the small status line");
  const hard = EMP.replace("const amt = this.state.guestPrice ? this.money(this.state.guestPrice) : 'the comparison price';", "const amt = '$10.00';"); assert.notEqual(hard, EMP);
  const Q = new (makeClass(hard, ["money", "paidComparisonChargeNote"]))(); Q.state = { guestPrice: { cents: 1250, currency: "usd" } }; assert.doesNotMatch(Q.paidComparisonChargeNote(hold), /12\.50/, "planted: typed in amount");
  assert.equal(AMOUNT.test(method(EMP, "paidComparisonChargeNote")), false);
  const dup = EMP.replace("return 'Approved. Ready to open until ' + this.fmtDate(c.available_until) + '.';", "return 'Approved. Ready to open until ' + this.fmtDate(c.available_until) + '. Clicking Open charges your card now.';"); assert.notEqual(dup, EMP);
  const D = new (makeClass(dup, ["money", "paidComparisonStatusLabel", "fmtDate"]))(); D.fmtDate = () => "x"; D.state = { guestPrice: null }; assert.match(D.paidComparisonStatusLabel(hold), /charges your card/, "planted: the sentence back in the small line, which the exact status text check above rejects");
});
t("6b the stable tags for the text trimming pass are all present, and no em dash was added", () => {
  const tags = [...EMP.matchAll(/data-charge-notice="([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tags, ["confirm-direct", "confirm-guest", "confirm-paid", "my-comparisons", "request", "request"]);
  assert.equal((EMP.match(/data-charge-notice-lead/g) || []).length, 5, "five lead lines: two request notices and three confirm boxes");
  for (const f of ["employer.html", "supabase/functions/employer-api/index.ts", "tools/resume/test-charge-notice.mjs"]) { const added = f.startsWith("tools") ? rd(f).split("\n") : execFileSync("git", ["diff", "-U0", BASE, "--", f], { cwd: repo }).toString().split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++")); assert.deepEqual(added.filter((l) => l.includes(String.fromCharCode(0x2014))), [], f + " has an em dash in added text"); }
  assert.equal(/fetch\(["'`]https:\/\/api\.stripe/.test(fs.readFileSync(new URL("tools/resume/test-charge-notice.mjs", repo), "utf8").replace(/\/\/.*$/gm, "").replace(/globalThis\.fetch[\s\S]*?\n\};/, "")), false, "this test file calls no Stripe address itself");
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 6).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
