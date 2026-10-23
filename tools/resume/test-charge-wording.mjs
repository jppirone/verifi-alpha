// node tools/resume/test-charge-wording.mjs   (no network, no Stripe call, no model call, no database)
// BM (October 21, 2026): ONE short charge sentence on every screen, a "Your card was charged" pop-up after an Open that really took the charge, the My comparisons rows, and an accurate lookup row label.
// The real employer-api source runs against an in-memory stand-in (the Stripe side is a stub inside this process). Page code is cut out of employer.html by method name and run.
// NOT proved: the look on screen, the real Stripe page, a real charge.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const EMP = rd("employer.html"), API = rd("supabase/functions/employer-api/index.ts");
const BASE = process.env.BM_BASE || "de8bf67";
const git = (...a) => execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28 }).toString().replace(/\r\n/g, "\n");
const tests = []; const t = (name, fn) => tests.push([name, fn]);
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => { const m = method(src, n); assert.ok(m, "method " + n); return m; }).join("\n") + " }")();
const PRICE = (c) => ({ cents: c, currency: "usd" });
const sentenceOf = (src, price) => { const C = makeClass(src, ["money", "chargeSentence"]); const p = new C(); p.state = { guestPrice: price }; return p.chargeSentence(); };
const AMOUNT = /\$\s?\d|\b\d+\.\d{2}\b|\b\d+\s*(dollars|usd|cents)\b/i;

// ------------------------------------------------------------------ the server stand-in (the real employer-api against stub tables and a Stripe stub)
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK, RESEND_API_KEY: "re_test", STRIPE_SECRET_KEY: "sk_test" })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
let DB, STRIPE, CAPTURE_OK, RPC_CALLS, EXTERNAL, INTENT_OK;
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const matches = (row, params) => { for (const [k, v] of params) { if (["select", "limit", "order"].includes(k)) continue; const m = /^(eq|is|gte)\.(.*)$/s.exec(v); if (!m) continue; const [, op, val] = m, cell = row[k]; if (op === "eq" && String(cell) !== val) return false; if (op === "is" && (val === "null" ? cell != null : cell == null)) return false; if (op === "gte" && !(String(cell) >= val)) return false; } return true; };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = (init.method || "GET").toUpperCase();
  if (u.host === "api.stripe.com") {
    const form = new URLSearchParams(init.body || ""); STRIPE.push({ method, path: u.pathname, form: Object.fromEntries(form) });
    if (/\/capture$/.test(u.pathname)) return CAPTURE_OK ? ok({ id: "pi_1", status: "succeeded" }) : ok({ error: { message: "declined" } }, 402);
    if (u.pathname === "/v1/payment_intents" && method === "POST") return INTENT_OK ? ok({ id: "pi_new", status: "succeeded" }) : ok({ id: "pi_new", status: "requires_payment_method" }, 402);
    if (/^\/v1\/payment_intents\/[^/]+$/.test(u.pathname)) return ok({ id: "pi_1", status: CAPTURE_OK ? "succeeded" : "requires_capture" });
    if (u.pathname === "/v1/customers") return ok({ id: "cus_stub" });
    if (u.pathname === "/v1/checkout/sessions") return ok({ id: "cs_stub", url: "https://checkout.stripe.test/c/cs_stub" });
    return ok({}, 404);
  }
  if (u.host === "db.test" && u.pathname.startsWith("/functions/v1/")) return ok({ ok: true, content: { kind: "resume_comparison" }, assembled_at: "2026-10-21T00:00:00Z", resume: { sections: [] } });
  if (u.host !== "db.test") { EXTERNAL.push(String(url)); return ok({}, 599); }
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(u.pathname);
  if (rpc) { RPC_CALLS.push(rpc[1]); if (rpc[1] === "open_paid_comparison") { const paid = (DB.employer_payments || []).some((p) => p.status === "paid" && !p.refunded_at); const rq = DB.comparison_requests[0]; if (rq.first_delivered_at) return ok([{ ok: true, reason: "reopen", first_open: false, window_ends_at: rq.view_window_ends_at }]); return paid ? ok([{ ok: true, reason: "ok", first_open: true, window_ends_at: "2026-11-11T00:00:00Z" }]) : ok([{ ok: false, reason: "payment_required" }]); } return ok([{}]); }
  const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname); if (!tb) return ok({ error: "unknown" }, 404);
  const table = tb[1]; DB[table] = DB[table] || [];
  if (method === "GET") return ok(DB[table].filter((r) => matches(r, u.searchParams)));
  if (method === "PATCH") { const hit = DB[table].filter((r) => matches(r, u.searchParams)); hit.forEach((r) => Object.assign(r, JSON.parse(init.body))); return new Response(null, { status: 204 }); }
  if (method === "POST") { const row = { id: crypto.randomUUID(), ...(table === "employer_payments" ? { status: "created" } : {}), ...JSON.parse(init.body) }; DB[table].push(row); return init.headers?.Prefer?.includes("return=representation") ? ok([row], 201) : new Response(null, { status: 201 }); }
  return ok({}, 405);
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "charge-wording-"));
let n = 0;
async function load(source) {
  const src = source.replace(/\r\n/g, "\n").replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n");
  const file = path.join(TMP, `employer-api-${++n}.ts`); fs.writeFileSync(file, src); return (await import(pathToFileURL(file).href)).default.fetch;
}
const SESSION = "S".repeat(40), REQ = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const seed = async ({ price = { amount_cents: 1250, currency: "usd" }, method: how = "authorized", opened = false, org = false, cardSaved = true } = {}) => {
  DB = { employer_users: [{ id: "u1", email: "boss@corp.test", name: "Boss", org_id: null, role: "owner" }], employer_sessions: [{ id: "s1", employer_user_id: "u1", token_hash: await sha(SESSION), expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null }],
    comparison_requests: [{ id: REQ, employer_user_id: "u1", access_method: org ? "org" : "guest", status: "approved", candidate_id: "c1", first_delivered_at: opened ? "2026-10-21T00:00:00Z" : null, view_window_ends_at: opened ? "2099-01-01T00:00:00Z" : null, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1", requester_email: "boss@corp.test", kind: "resume_comparison", lookup_id: null, card_saved_at: cardSaved ? "2026-10-21T00:00:00Z" : null }],
    employer_pricing: price ? [{ key: "guest_comparison", ...price }] : [], employer_payments: how === "authorized" ? [{ id: "pay1", comparison_request_id: REQ, status: "authorized", stripe_payment_intent_id: "pi_1", amount_cents: price ? price.amount_cents : 0, currency: "usd", refunded_at: null }] : [], comparison_request_documents: [] };
  STRIPE = []; CAPTURE_OK = true; INTENT_OK = true; RPC_CALLS = []; EXTERNAL = []; };
const call = async (f, action, params = {}) => { const r = await f(new Request("http://x/", { method: "POST", body: JSON.stringify({ session_token: SESSION, action, params }) })); return { status: r.status, body: await r.json() }; };

// ------------------------------------------------------------------ 1. one sentence, one builder
t("1 the sentence: ONE builder in the page, the same words in the Stripe text for the same amount (bold), the words and no number without a price; planted: a typed in amount, a different server sentence, a changed page sentence are caught", async () => {
  const f = await load(API);
  for (const [cents, price] of [[1000, { amount_cents: 1000, currency: "usd" }], [1250, { amount_cents: 1250, currency: "usd" }], [2000, { amount_cents: 2000, currency: "usd" }], [null, null]]) {
    await seed({ price, cardSaved: false }); await call(f, "start_card_setup", { request_id: REQ });
    const server = STRIPE.find((c) => c.path === "/v1/checkout/sessions").form["custom_text[submit][message]"];
    const page = sentenceOf(EMP, cents ? PRICE(cents) : null);
    assert.equal(server, "**" + page + "**", "server text equals the page sentence in bold for " + cents);
    if (!cents) { assert.match(page, /^the comparison price is charged only when you open the comparison\. Nothing is charged now\.$/); assert.equal(/\d/.test(page), false); }
  }
  assert.equal(sentenceOf(EMP, PRICE(1000)), "$10.00 is charged only when you open the comparison. Nothing is charged now.");
  // planted
  const serverBad = API.replace("is charged only when you open the comparison. Nothing is charged now.**`", "is charged only when you open the comparison, nothing is charged now.**`"); assert.notEqual(serverBad, API);
  await seed({ cardSaved: false }); await call(await load(serverBad), "start_card_setup", { request_id: REQ });
  assert.notEqual(STRIPE.find((c) => c.path === "/v1/checkout/sessions").form["custom_text[submit][message]"], "**" + sentenceOf(EMP, PRICE(1250)) + "**", "planted: a drifted server sentence is caught");
  const pageBad = EMP.replace("' is charged only when you open the comparison. Nothing is charged now.'", "' is only charged when you open the comparison. Nothing is charged now.'"); assert.notEqual(pageBad, EMP);
  assert.notEqual(sentenceOf(pageBad, PRICE(1250)), sentenceOf(EMP, PRICE(1250)), "planted: a drifted page sentence is caught");
  const typed = EMP.replace("return (this.state.guestPrice ? this.money(this.state.guestPrice) : 'the comparison price') + ' is charged only", "return '$10.00' + ' is charged only"); assert.notEqual(typed, EMP);
  assert.equal(AMOUNT.test(sentenceOf(typed, PRICE(1250))), true, "planted: a typed in amount is caught by the scan");
  assert.deepEqual(EXTERNAL, [], "no Stripe address was called; only the stand-in");
});

t("2 each place shows the sentence ONCE and nothing else long: both request notices (sentence and the small link only), the three confirm boxes (sentence, the one short line), the Request sent screen; the long paragraphs and the hold mechanics lines are gone", () => {
  const region = (anchor, len) => { const i = EMP.indexOf(anchor); assert.ok(i > 0, anchor); return EMP.slice(i, i + len); };
  for (const id of ['id="charge-notice-request"', 'id="charge-notice-access"']) { const b = region(id, 760); assert.equal((b.match(/\{\{ chargeSentence \}\}/g) || []).length, 1, id); assert.doesNotMatch(b, /Your card is only charged|next screen is Stripe|is held on your card/); assert.match(b, /How the charge works/); }
  const sc = (a, z) => EMP.slice(EMP.indexOf(a), EMP.indexOf(z, EMP.indexOf(a)));
  for (const [a, z] of [['id="direct-confirm"', "</sc-if>"], ['data-charge-notice="confirm-paid"', "</sc-if>"], ['data-charge-notice="confirm-guest"', "</sc-if>"]]) { const b = sc(a, z); assert.equal((b.match(/\{\{ chargeSentence \}\}/g) || []).length, 1, a); assert.equal((b.match(/never-charged/g) || []).length, 1, a); assert.doesNotMatch(b, /7 days|hold<\/b>|&mdash;|place a|saves your card/); }
  const sent = region('data-charge-notice="request-sent"', 200); assert.match(sent, /\{\{ chargeSentence \}\}/);
  assert.equal((EMP.match(/\{\{ chargeSentence \}\}/g) || []).length, 6, "the sentence appears at exactly six places: two request notices, three confirm boxes, the Request sent screen");
});

// ------------------------------------------------------------------ 3. How the charge works: every statement proved from the code
const HELP = (() => { const C = makeClass(EMP, ["chargeHelpLines"]); const p = new C(); return { paid: p.chargeHelpLines("paid"), guest: p.chargeHelpLines("guest") }; })();
const CCR = rd("supabase/functions/candidate-comparison-requests/index.ts"), ECM = rd("supabase/functions/employer-comparison/index.ts"), MIG = rd("supabase/migrations/20260926000000_gap21_comparison_redesign_schema.sql");
const PROOFS = {
  "Card details are entered with Stripe, not on this site.": [() => /mode: "setup", customer: customerId!/.test(API) && /start_card_setup: \{/.test(API), "employer-api start_card_setup creates a Stripe Checkout session in setup mode (the card is entered on Stripe's hosted page)"],
  "The hold is placed automatically when the candidate approves.": [() => /action: "place_hold_on_approval", request_id: r\.id/.test(CCR) && /action === "place_hold_on_approval"/.test(ECM) && /capture_method/.test(ECM), "candidate-comparison-requests calls place_hold_on_approval right after an approval; employer-comparison places a capture_method manual hold"],
  "You have 7 days after approval to open it.": [() => /const SNAPSHOT_DAYS = 7;/.test(CCR) && /approved_at: approvedAt, snapshot_expires_at: new Date\(Date\.now\(\) \+ SNAPSHOT_DAYS \* 24 \* 60 \* 60 \* 1000\)/.test(CCR), "approval sets snapshot_expires_at to now plus SNAPSHOT_DAYS (7) days"],
  "The real charge happens when you open it.": [() => /if \(authorized\) chargedNow = await captureGuestHoldLocal\(authorized\)/.test(API) && (API.match(/\/capture`/g) || []).length === 1, "open_paid_comparison captures the hold; the capture call exists only inside captureGuestHoldLocal"],
  "Once opened, it stays reopenable free for 21 days.": [() => /view_window_ends_at = now\(\) \+ interval '21 days'/.test(MIG), "migration 20260926000000 open_paid_comparison sets view_window_ends_at to now plus 21 days at the first open, and a later open inside the window is a reopen with first_open false"],
  "If the candidate declines, does not answer within 72 hours, or you do not open it in time, the hold expires and you are never charged.": [() => /now\(\) \+ interval '72 hours'/.test(MIG) && /place_hold_on_approval/.test(CCR) && /A hold nobody ever redeems simply expires on Stripe's own schedule/.test(ECM), "the answer window is 72 hours; a hold is placed only at approval (so a decline or no answer places none); an unopened hold expires on Stripe's own schedule and is never captured (employer-comparison header)"],
  "If the candidate approves, we email you a link. You enter your card once on Stripe, not on this site, and that places a hold.": [() => /comparison=/.test(CCR) && /capture_method/.test(ECM) && /hosted Checkout|Checkout/.test(ECM), "the approval email links to the guest comparison page; the card is entered on Stripe's hosted Checkout and the result is a capture_method manual hold"],
  "The real charge happens the moment you are shown the result.": [() => /CAPTURED .{1,3} the real, only charge .{1,3} only inside `enter`\/`open`\/open_paid_comparison, at the moment of genuine/.test(ECM), "employer-comparison header: the capture happens only inside enter, open and open_paid_comparison, at the moment of redemption"],
  "If the candidate declines or does not answer within 72 hours, nothing is placed on your card. If you place a hold and never open it, the hold expires on its own and you are never charged.": [() => /now\(\) \+ interval '72 hours'/.test(MIG) && /simply expires on Stripe's own schedule/.test(ECM), "72 hour answer window; unopened holds expire on Stripe's own schedule and are never captured"],
};
t("3 'How the charge works': reachable from the small link beside the sentence (both request screens and the claim token confirm box), opens one dialog, and EVERY statement in it is proved from the code (each statement and its proof are in the report); a statement without a proof fails here", () => {
  assert.equal((EMP.match(/openChargeHelp \}\}/g) || []).length, 2, "the paid link is on both request notices");
  assert.equal((EMP.match(/openChargeHelpGuest \}\}/g) || []).length, 1, "the claim token link is in the claim token confirm box");
  assert.match(EMP, /id="charge-help" data-charge-notice="how-it-works" role="dialog" aria-modal="true"/);
  for (const line of [...HELP.paid, ...HELP.guest]) { const pr = PROOFS[line]; assert.ok(pr, "no proof recorded for: " + line); assert.equal(pr[0](), true, "proof failed for: " + line); }
  assert.deepEqual(Object.keys(PROOFS).filter((k) => ![...HELP.paid, ...HELP.guest].includes(k)), [], "no stale proof for a line that is gone");
  // planted: an untrue statement (a 14 day window) has no proof and fails
  const bad = EMP.replace("'You have 7 days after approval to open it.'", "'You have 14 days after approval to open it.'"); assert.notEqual(bad, EMP);
  const C = makeClass(bad, ["chargeHelpLines"]); const lines = new C().chargeHelpLines("paid"); assert.ok(lines.some((l) => !PROOFS[l]), "planted: an unproved statement is caught");
  for (const l of [...HELP.paid, ...HELP.guest]) { assert.equal(l.includes(String.fromCharCode(0x2014)), false); assert.equal(l.includes(" -- "), false); }
});

// ------------------------------------------------------------------ 4. no " -- " and no em dash in new or changed text
t("4 no ' -- ', no HTML em dash entity and no em dash in anything added or changed by this build (page, edge function, tests); planted ones are caught", () => {
  const dash = String.fromCharCode(0x2014);
  const bad = (lines) => lines.filter((l) => l.includes(" -- ") || l.includes(dash) || /&mdash;|&#8212;/.test(l));
  for (const f of ["employer.html", "supabase/functions/employer-api/index.ts", "tools/resume/test-charge-wording.mjs", "tools/resume/test-charge-notice.mjs"]) {
    const added = git("diff", "-U0", BASE, "--", f).split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++"));
    // the page and the edge function: none of the three; the test files describe the ' -- ' pattern in their own titles, so they are held to the em dash only
    const hits = f.startsWith("tools/") ? added.filter((l) => l.includes(dash)) : bad(added);
    assert.deepEqual(hits, [], f + " has a dash in added text");
  }
  assert.equal(rd("tools/resume/test-charge-wording.mjs").includes(dash), false, "this test file holds no em dash");
  assert.equal(bad(["a thing -- another"]).length, 1); assert.equal(bad(["a thing " + dash + " another"]).length, 1); assert.equal(bad(["a &mdash; b"]).length, 1);
});

// ------------------------------------------------------------------ 5. Request sent screen
t("5 Request sent: 'Your card is saved.' then the sentence, no ' -- ' and no long explanation; the not saved states say what happened in one short line and also show the sentence; planted: the old long text is caught", async () => {
  const mkP = (src) => { const C = makeClass(src, ["afterCardSetupReturn", "chargeSentence", "money"]); const p = new C(); p.calls = []; p.state = { guestPrice: PRICE(1000), realToken: "tok" }; p.setState = (o) => { p.calls.push(o); p.state = { ...p.state, ...o }; }; p.loadGuestPrice = () => p.calls.push({ loadPrice: true }); return p; };
  let p = mkP(EMP); p.empCall = async () => ({ data: { ok: true, comparisons: [{ id: "r1", card_saved: true }] } }); await p.afterCardSetupReturn("r1", "success", true);
  const last = () => p.calls[p.calls.length - 1];
  assert.equal(last().requestSentLine, "Your card is saved."); assert.equal(last().requestSentDetail, ""); assert.equal(last().requestSentKind, "paid");
  assert.match(EMP, /<div data-charge-notice="request-sent"[^>]*>\{\{ chargeSentence \}\}<\/div>/);
  p = mkP(EMP); p.state.guestPrice = null; p.empCall = async () => ({ data: { ok: true, comparisons: [{ id: "r1", card_saved: true }] } }); await p.afterCardSetupReturn("r1", "success", true); assert.ok(p.calls.some((c) => c.loadPrice), "the price is asked for after the return from Stripe");
  p = mkP(EMP); p.empCall = async () => ({ data: { ok: true, comparisons: [] } }); const orig = global.setTimeout; global.setTimeout = (fn) => orig(fn, 0); await p.afterCardSetupReturn("r1", "success", true); global.setTimeout = orig;
  assert.equal(last().requestSentLine, "Request sent."); assert.match(last().requestSentDetail, /^We haven't confirmed your card here yet\./);
  p = mkP(EMP); await p.afterCardSetupReturn("r1", "cancel", true); assert.match(last().requestSentDetail, /^You left before saving a card\. You can add one any time before the candidate answers, from My Comparisons in your account\.$/);
  const flat = JSON.stringify(p.calls); assert.equal(flat.includes(" -- "), false);
  const bad = EMP.replace("requestSentLine: saved ? 'Your card is saved.' : 'Request sent.',\n      requestSentDetail: saved ? '' :", "requestSentLine: 'Request sent.',\n      requestSentDetail: saved ? \"Your card is saved. If the candidate approves, we'll place the hold automatically and email you -- you won't need to enter a card again.\" :"); assert.notEqual(bad, EMP);
  const q = mkP(bad); q.empCall = async () => ({ data: { ok: true, comparisons: [{ id: "r1", card_saved: true }] } }); await q.afterCardSetupReturn("r1", "success", true); assert.match(JSON.stringify(q.calls), / -- /, "planted: the old long text is caught by the dash scan");
});

// ------------------------------------------------------------------ 6. My comparisons rows
t("6 My comparisons: waiting has the one line; approved has ONE bold line with the open by date; opened is as before; an organization employer's list is unchanged; planted: the old waiting text, a grey line beside the bold one are caught", () => {
  const C = makeClass(EMP, ["money", "paidComparisonStatusLabel", "paidComparisonChargeNote", "comparisonStatusLabel", "fmtDate", "fmtDateTime"]); const P = new C();
  P.state = { guestPrice: PRICE(1250) };
  const waiting = { status: "awaiting_candidate", answer_by: "2026-10-24T10:00:00Z", card_saved: true, hold_state: "none" };
  const d = P.fmtDate("2026-10-24T10:00:00Z");
  assert.equal(P.paidComparisonStatusLabel(waiting), "Waiting for the candidate to answer (until " + d + "). Nothing is charged unless they approve and you open it.");
  assert.equal(P.paidComparisonStatusLabel({ ...waiting, card_saved: false }), P.paidComparisonStatusLabel(waiting), "the card state no longer changes the line (the Add a card button stays)");
  const ready = { status: "ready", hold_state: "holding", available_until: "2026-10-28T10:00:00Z" };
  assert.equal(P.paidComparisonChargeNote(ready), "Opening charges your card $12.50. Open by " + P.fmtDate("2026-10-28T10:00:00Z") + ", or the hold expires and you are not charged."); assert.equal(P.paidComparisonStatusLabel(ready), "");
  const opened = { status: "opened", opened_at: "2026-10-21T10:00:00Z", window_ends_at: "2026-11-11T10:00:00Z" };
  assert.equal(P.paidComparisonStatusLabel(opened), "Opened " + P.fmtDate(opened.opened_at) + ". You can reopen it free until " + P.fmtDateTime(opened.window_ends_at) + "."); assert.equal(P.paidComparisonChargeNote(opened), "");
  assert.equal(P.comparisonStatusLabel({ status: "ready", available_until: "2026-10-28T10:00:00Z" }), "Approved. Ready to open until " + P.fmtDate("2026-10-28T10:00:00Z") + ". Opening uses one lookup.", "the organization row text is unchanged");
  assert.match(EMP, /myPaidRows: \(s\.myPaidComparisons \|\| \[\]\)\.map/, "the new lines are built only from the pay per use list");
  const oldWait = EMP.replace("'Waiting for the candidate to answer (until ' + this.fmtDate(c.answer_by) + '). Nothing is charged unless they approve and you open it.'", "'Waiting for the candidate to answer (they have until ' + this.fmtDate(c.answer_by) + ').'"); assert.notEqual(oldWait, EMP);
  const Q = new (makeClass(oldWait, ["money", "paidComparisonStatusLabel", "fmtDate"]))(); Q.state = { guestPrice: PRICE(1250) }; assert.notEqual(Q.paidComparisonStatusLabel(waiting), P.paidComparisonStatusLabel(waiting), "planted: the old waiting line is caught");
  const grey = EMP.replace("if (c.hold_state === 'holding') return '';", "if (c.hold_state === 'holding') return 'Approved.';"); assert.notEqual(grey, EMP);
  const G = new (makeClass(grey, ["money", "paidComparisonStatusLabel", "fmtDate"]))(); G.state = { guestPrice: PRICE(1250) }; assert.notEqual(G.paidComparisonStatusLabel(ready), "", "planted: a grey line beside the bold one is caught");
});

// ------------------------------------------------------------------ 7. the server side of the pop-up
t("7 open_paid_comparison tells the page whether THIS call took the charge: a first open with a hold gives charged_now true and the amount actually charged; a direct charge (no hold) too; a free reopen, a failed charge and an organization request do not; no Stripe call leaves the process", async () => {
  const f = await load(API);
  await seed(); let r = await call(f, "open_paid_comparison", { request_id: REQ });
  assert.equal(r.status, 200); assert.equal(r.body.charged_now, true); assert.equal(r.body.charged_amount_cents, 1250); assert.equal(r.body.charged_currency, "usd"); assert.equal(r.body.window_ends_at, "2026-11-11T00:00:00Z"); assert.equal(r.body.first_open, true);
  assert.equal(STRIPE.filter((c) => /\/capture$/.test(c.path)).length, 1, "exactly one capture");
  await seed({ method: "none" }); r = await call(f, "open_paid_comparison", { request_id: REQ });
  assert.equal(r.status, 200); assert.equal(r.body.charged_now, true); assert.equal(r.body.charged_amount_cents, 1250); assert.equal(STRIPE.filter((c) => c.path === "/v1/payment_intents" && c.method === "POST").length, 1, "one direct charge, as before");
  await seed({ opened: true }); r = await call(f, "open_paid_comparison", { request_id: REQ }); assert.equal(r.status, 200); assert.equal(r.body.charged_now, false); assert.equal(r.body.charged_amount_cents, null); assert.equal(STRIPE.some((c) => /\/capture$/.test(c.path) || (c.path === "/v1/payment_intents" && c.method === "POST")), false, "a free reopen touches no charge call");
  await seed(); CAPTURE_OK = false; r = await call(f, "open_paid_comparison", { request_id: REQ }); assert.equal(r.status, 402); assert.equal(r.body.error, "payment_required"); assert.equal(r.body.charged_now, undefined, "a failed charge is the existing error, no pop-up data");
  await seed({ method: "none" }); INTENT_OK = false; r = await call(f, "open_paid_comparison", { request_id: REQ }); assert.notEqual(r.status, 200);
  await seed({ org: true }); r = await call(f, "open_paid_comparison", { request_id: REQ }); assert.equal(r.status, 404); assert.equal(STRIPE.length, 0, "an organization request is not on this path and no charge call is made");
  assert.deepEqual(EXTERNAL, []);
  // planted: always charged_now true / a typed amount are caught
  const always = API.replace("charged_now: charged !== null,", "charged_now: true,"); assert.notEqual(always, API);
  await seed({ opened: true }); r = await call(await load(always), "open_paid_comparison", { request_id: REQ }); assert.equal(r.body.charged_now, true, "planted: always true"); assert.notEqual(r.body.charged_amount_cents, 1250);
  const typed = API.replace("charged = { amount_cents: Number(pr.amount_cents), currency", "charged = { amount_cents: 1000, currency"); assert.notEqual(typed, API);
  await seed(); r = await call(await load(typed), "open_paid_comparison", { request_id: REQ }); assert.notEqual(r.body.charged_amount_cents, 1250, "planted: a typed in amount does not follow the charge, caught");
});

t("7b the charge path is untouched: against the base commit the only changes in open_paid_comparison are that the two existing charge calls keep their result, plus the read back and the three answer fields; nothing is added that writes; the charge calls, their order and arguments are the same", () => {
  const section = (src) => { const a = src.indexOf("  open_paid_comparison: {"); return src.slice(a, src.indexOf("\n  },\n", a)); };
  const norm = (s) => s.replace(/chargedNow = /g, "").replace(/^\s*let chargedNow = false;.*\n/m, "");
  const now = norm(section(API)).split("\n"), base = section(git("show", BASE + ":supabase/functions/employer-api/index.ts")).split("\n");
  const extraNow = now.filter((l) => !base.includes(l)), extraBase = base.filter((l) => !now.includes(l));
  assert.deepEqual(extraBase.map((l) => l.trim().slice(0, 60)), ["return ok({ content: liveJson.content, assembled_at: liveJson.assembled_at, window_ends_at: res.window_ends_at, first_open: !!res.first_open, document, generated_document: generatedDocument });".slice(0, 60)]);
  assert.ok(extraNow.every((l) => !/method: "(PATCH|POST|DELETE)"|rest\(/.test(l)), "no added write");
  assert.ok(extraNow.some((l) => /employer_payments\?comparison_request_id=eq\.\$\{r\.id\}&status=eq\.paid&select=amount_cents,currency/.test(l)), "the amount is read back with a SELECT");
  const calls = (s) => s.split("\n").filter((l) => /captureGuestHoldLocal\(|chargeGuestNow\(/.test(l)).map((l) => l.replace(/chargedNow = /, "").trim());
  assert.deepEqual(calls(section(API)), calls(section(git("show", BASE + ":supabase/functions/employer-api/index.ts"))), "the two charge calls are character for character the same");
  // planted: a changed charge call is caught
  const bad = API.replace("chargedNow = await chargeGuestNow(r.id, r);", "chargedNow = await chargeGuestNow(r.id, { ...r, kind: 'license_report' });"); assert.notEqual(bad, API);
  assert.notDeepEqual(calls(section(bad)), calls(section(git("show", BASE + ":supabase/functions/employer-api/index.ts"))), "planted: a changed charge call is caught");
  // scope: nothing outside the charge path files changed
  // BI: the range is BM's own commit (base to cbb33f5), so later builds on other files do not change what this check says about BM
  const names = git("diff", "--name-only", BASE, process.env.BM_TIP || "cbb33f5").split("\n").filter(Boolean).filter((x) => !x.startsWith("tools/")).sort();
  assert.deepEqual(names, ["employer.html", "supabase/functions/employer-api/index.ts"], "candidate.html, confirm-resume-data and resume-resubmission are not touched");
});

// ------------------------------------------------------------------ 8. the pop-up in the page (fake document: no browser here)
function popupScenario(src) {
  const problems = [];
  const handlers = []; const focusLog = []; let connectedOpener = true;
  const mkEl = (id) => ({ id, focus() { focusLog.push(id); document.activeElement = this; }, isConnected: true });
  const ok = mkEl("charged-popup-ok"), x = mkEl("charged-popup-x");
  const box = { contains: (e) => e === ok || e === x, querySelectorAll: () => [x, ok] };
  const opener = Object.assign(mkEl("open-button"), { get isConnected() { return connectedOpener; } });
  global.document = { activeElement: opener, addEventListener: (k, fn, cap) => handlers.push({ k, fn, cap }), removeEventListener: (k, fn) => { const i = handlers.findIndex((h) => h.fn === fn); if (i >= 0) handlers.splice(i, 1); }, getElementById: (id) => id === "charged-popup-ok" ? ok : id === "charged-popup" ? box : null };
  const C = makeClass(src, ["openChargedPopup", "closeChargedPopup", "trapTab", "openMyPaidComparison", "fmtDateTime", "money"]);
  const mk = (response) => { const p = new C(); p.state = { myPaidBusy: false, myPaidComparisons: [] }; p.setState = (o) => { p.state = { ...p.state, ...o }; }; p.empCall = async () => response; p.showCompare = (st) => p.setState(st); p.startGuestTimer = () => {}; p.loadReal = async () => {}; return p; };
  return (async () => {
    const real = global.setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
    try {
      // charged: shows the amount actually charged and the real reopen date, then Escape closes
      let p = mk({ status: 200, data: { ok: true, charged_now: true, charged_amount_cents: 1250, charged_currency: "usd", window_ends_at: "2026-11-11T10:00:00Z" } }); await p.openMyPaidComparison("r1", "x");
      if (!p.state.chargedPopup || p.state.chargedPopup.cents !== 1250 || p.state.chargedPopup.until !== "2026-11-11T10:00:00Z") problems.push("not shown after a charging click");
      if (focusLog[focusLog.length - 1] !== "charged-popup-ok") problems.push("focus did not move into the dialog");
      const key = handlers.find((h) => h.k === "keydown"); if (!key) problems.push("no key handler"); else {
        // Tab on the last button wraps to the first; Shift+Tab on the first wraps to the last
        document.activeElement = ok; let prevented = false; key.fn({ key: "Tab", shiftKey: false, preventDefault: () => { prevented = true; } }); if (!prevented || focusLog[focusLog.length - 1] !== "charged-popup-x") problems.push("focus is not trapped");
        key.fn({ key: "Escape", preventDefault() {} }); if (p.state.chargedPopup) problems.push("Escape did not close it"); if (handlers.some((h) => h.k === "keydown")) problems.push("the key handler stayed after closing");
        if (focusLog[focusLog.length - 1] !== "open-button") problems.push("focus did not return to the opener");
      }
      // OK, X (same function) and a click outside close it; a click inside does not
      p = mk({ status: 200, data: { ok: true, charged_now: true, charged_amount_cents: 1250, charged_currency: "usd", window_ends_at: "2026-11-11T10:00:00Z" } }); await p.openMyPaidComparison("r1", "x"); p.closeChargedPopup(); if (p.state.chargedPopup) problems.push("OK/X did not close it");
      const props = (EMP_SRC.match(/closeChargedPopupBackdrop: \(e\) => \{[^}]*\}/) || [""])[0]; const bd = new Function("self", "return " + props.replace("closeChargedPopupBackdrop: ", "").replace(/this\./g, "self.") + ";");
      p = mk({ status: 200, data: { ok: true, charged_now: true, charged_amount_cents: 1250, charged_currency: "usd", window_ends_at: "2026-11-11T10:00:00Z" } }); await p.openMyPaidComparison("r1", "x");
      const outer = {}; bd(p)({ target: outer, currentTarget: outer }); if (p.state.chargedPopup) problems.push("a click outside did not close it");
      await p.openMyPaidComparison("r1", "x"); bd(p)({ target: {}, currentTarget: {} }); if (!p.state.chargedPopup) problems.push("a click inside closed it");
      p.closeChargedPopup();
      // never shown: a free reopen, a response without the field, a failed charge
      for (const [label, resp] of [["free reopen", { status: 200, data: { ok: true, charged_now: false, charged_amount_cents: null, window_ends_at: "2026-11-11T10:00:00Z" } }], ["no field", { status: 200, data: { ok: true, window_ends_at: "2026-11-11T10:00:00Z" } }], ["failed charge", { status: 402, data: { ok: false, error: "payment_required" } }], ["zero amount", { status: 200, data: { ok: true, charged_now: true, charged_amount_cents: 0, window_ends_at: "x" } }]]) { p = mk(resp); await p.openMyPaidComparison("r1", "x"); if (p.state.chargedPopup) problems.push("shown on " + label); }
      // a reload cannot bring it back: it lives only in page state
      if (/localStorage|sessionStorage|setFlag/.test(method(src, "openChargedPopup"))) problems.push("the pop-up is stored somewhere that survives a reload");
    } finally { global.setTimeout = real; delete global.document; }
    return problems;
  })();
}
const EMP_SRC = EMP;
t("8 the pop-up: shown only when the server says THIS click charged, with the amount charged and the real reopen date; closes by OK, X, a click outside and Escape; no automatic close; focus moves in, is trapped and returns; not on a free reopen, a failed charge or a reload; planted bugs (always shown, shown on a reopen, a typed in amount, no Escape) are each caught", async () => {
  assert.deepEqual(await popupScenario(EMP), []);
  const plants = [
    ["always shown", "if (d.charged_now === true && d.charged_amount_cents > 0) this.openChargedPopup(", "if (true) this.openChargedPopup("],
    ["shown on a reopen", "if (d.charged_now === true && d.charged_amount_cents > 0) this.openChargedPopup(", "if (d.charged_now !== undefined) this.openChargedPopup("],
    ["a typed in amount", "this.openChargedPopup(d.charged_amount_cents, d.charged_currency || 'usd', d.window_ends_at)", "this.openChargedPopup(1000, d.charged_currency || 'usd', d.window_ends_at)"],
    ["no close on Escape", "if (e.key === 'Escape') { e.preventDefault(); this.closeChargedPopup(); } else if (e.key === 'Tab') this.trapTab(e, 'charged-popup');", "if (e.key === 'Tab') this.trapTab(e, 'charged-popup');"],
  ];
  for (const [name, from, to] of plants) { assert.ok(EMP.includes(from), "plant anchor: " + name); const bad = EMP.replace(from, to); assert.ok((await popupScenario(bad)).length > 0, "NOT CAUGHT: " + name); }
  // the markup: dialog role, X, OK, text, tag; no timer closes it
  assert.match(EMP, /id="charged-popup" data-charge-notice="charged-popup" role="dialog" aria-modal="true" aria-labelledby="charged-popup-title"/);
  assert.match(EMP, /id="charged-popup-x"[^>]*aria-label="Close"/); assert.match(EMP, /id="charged-popup-ok"[^>]*>OK<\/button>/);
  assert.match(EMP, /chargedPopupLead: s\.chargedPopup \? 'Your card was charged ' \+ this\.money\(\{ cents: s\.chargedPopup\.cents, currency: s\.chargedPopup\.currency \}\) \+ '\.' : ''/);
  assert.match(EMP, /'You can reopen this comparison free until ' \+ this\.fmtDateTime\(s\.chargedPopup\.until\) \+ '\.'/);
  assert.equal(/openChargedPopup[\s\S]{0,900}setTimeout\([^)]*closeChargedPopup/.test(EMP), false, "nothing closes it by itself");
  const wrong = EMP.replace("'Your card was charged '", "'You paid '"); assert.notEqual(wrong, EMP);
});

// ------------------------------------------------------------------ 9. lookup row label
t("9 'Your lookups' row label: says what is actually open (waiting, approved with the open by date, opened with the reopen date) from the lists the page already holds, nothing when it cannot tell; no 'Request in progress' remains; the Request verified record button logic is unchanged; planted: the old label is caught", () => {
  const C = makeClass(EMP, ["lookupRequestLabel", "fmtDate", "fmtDateTime"]); const p = new C();
  const L = (id) => ({ lookup_id: "L1", open_request_id: id });
  p.state = { myPaidComparisons: [{ id: "a", status: "awaiting_candidate" }, { id: "b", status: "ready", available_until: "2026-10-28T10:00:00Z" }, { id: "c", status: "opened", window_ends_at: "2026-11-11T10:00:00Z" }, { id: "d", status: "opened", window_ends_at: null }, { id: "e", status: "not_authorized" }], comparisons: [{ id: "f", status: "awaiting_candidate" }, { id: "g", status: "opened" }] };
  assert.equal(p.lookupRequestLabel(L("a")), "Waiting for the candidate");
  assert.equal(p.lookupRequestLabel(L("b")), "Approved, open by " + p.fmtDate("2026-10-28T10:00:00Z"));
  assert.equal(p.lookupRequestLabel(L("c")), "Opened, reopen free until " + p.fmtDateTime("2026-11-11T10:00:00Z"));
  for (const id of ["d", "e", "g", "zzz", null]) assert.equal(p.lookupRequestLabel(L(id)), "", "nothing for " + id);
  assert.equal(p.lookupRequestLabel(L("f")), "Waiting for the candidate", "an organization employer's list is used too");
  assert.equal(EMP.includes("Request in progress"), false); assert.equal((EMP.match(/data-charge-notice="lookup-status"/g) || []).length, 3, "the three lookup lists show the new label");
  assert.match(EMP, /canRequest: !l\.open_request_id, hasRequestStatus: !!this\.lookupRequestLabel\(l\), requestStatus: this\.lookupRequestLabel\(l\),/, "the button condition is still !open_request_id");
  assert.equal((EMP.match(/Request verified record<\/button>/g) || []).length, 3, "the button is unchanged in all three lists");
  const old = EMP.replace("if (!c) return '';\n    if (c.status === 'awaiting_candidate') return 'Waiting for the candidate';", "if (!c) return 'Request in progress';\n    if (c.status === 'awaiting_candidate') return 'Waiting for the candidate';"); assert.notEqual(old, EMP);
  const Q = new (makeClass(old, ["lookupRequestLabel", "fmtDate", "fmtDateTime"]))(); Q.state = { myPaidComparisons: [], comparisons: [] }; assert.notEqual(Q.lookupRequestLabel(L("zzz")), "", "planted: the old label is back, and the exact check above rejects it");
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 7).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
