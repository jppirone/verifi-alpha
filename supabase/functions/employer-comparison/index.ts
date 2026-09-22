// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// EMPLOYER COMPARISON, GUEST PATH (2026-09-20, Stage 3). For an employer with NO account: pay once, view once.
//
// Nothing here identifies a person by an id alone. There are exactly two capabilities, both random, both stored only as SHA-256 hashes:
//   * the CLAIM token, returned once by check-existence to the browser that completed a matched Tier 1 lookup: it lets that browser
//     REQUEST a comparison for that lookup (and is burned by a successful request);
//   * the GUEST token, minted at approval and emailed to the requester's confirmed address (candidate-comparison-requests): it is the
//     only way to see the request's state, pay for it and open it. A wrong or unknown token of either kind is the same 404/"unavailable".
//
// Actions (POST {action, ...}):
//   price    -> the current one-time price (from employer_pricing; the page never carries a price of its own)
//   request  -> {lookup_id, claim_token, attestation}: create the request (create_comparison_request, method "guest") and tell the candidate
//   status   -> {token}: where this request stands (awaiting_payment | payment_pending | ready_to_open | open | closed | unavailable); read-only
//   enter    -> {token}: A VISIT TO THE LINK, and THE NORMAL DELIVERY POINT (2026-09-21; authorize-then-capture 2026-09-22). Same answer as
//               status, but if an authorized (capturable) hold exists it is CAPTURED right then — this is the actual charge, made only at
//               genuine redemption, never before — and the result comes back in `delivered`; inside an open 30 minute window it is served
//               again free. Idempotent: safe on every visit, so a redirect that never finished costs nothing (the next visit captures and
//               delivers; a hold that expired uncaptured in the meantime simply never gets charged at all)
//   pay      -> {token}: start (or resume) the ONE hold for this request (Stripe Checkout with capture_method=manual, card only); returns
//               the Stripe hosted Checkout URL. Only for an approved, unopened request whose snapshot still has time; the amount is the
//               server's price at that moment. Nothing is charged by this call — it only places a hold
//   open     -> {token}: the same capture-and-redeem as `enter`, on request (kept as the fallback button). open_guest_comparison (SQL)
//               redeems the paid payment exactly once and starts a 30 minute view window; opens inside the window re-serve the snapshot
//               free; after it, 410 window_closed
//   close    -> {token}: end the view now (the window closes and the snapshot is deleted)
//
// Money (2026-09-22, authorize-then-capture): `pay` only places a hold on the card (capture_method=manual). The hold is authorized —
// capturable, still uncharged — only when the verified Stripe webhook (employer-stripe-events, payment_intent.amount_capturable_updated)
// says so, never by the browser returning from Stripe. The hold is CAPTURED — the real, only charge — only inside `enter`/`open`, at the
// moment of genuine redemption, and nowhere else. A hold nobody ever redeems simply expires on Stripe's own schedule (about 7 days for a
// card, customer-initiated) and is never captured: no refund is ever needed because no charge ever happened. Card details are only ever
// entered on Stripe's hosted page.
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const JSON_H = { ...REST, "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const RETURN_BASE = "https://alpha.applitrust.com/employer.html";
const MIN_SNAPSHOT_LEFT_MS = 60 * 60 * 1000; // never start a payment for a snapshot about to be discarded

const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...JSON_H, ...(init.headers || {}) } });
async function rows(path: string): Promise<any[]> {
  const r = await rest(path);
  if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
async function sha256Hex(raw: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status}`);
  return await r.json();
}
async function stripe(method: string, path: string, form?: URLSearchParams, idem?: string): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: form ? form.toString() : undefined,
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

async function guestPrice(): Promise<{ amount_cents: number; currency: string } | null> {
  return (await rows("employer_pricing?key=eq.guest_comparison&select=amount_cents,currency"))[0] || null;
}
async function requestByToken(token: unknown): Promise<any | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  return (await rows(`comparison_requests?guest_token_hash=eq.${await sha256Hex(token.toLowerCase())}&access_method=eq.guest&select=*`))[0] || null;
}

// The real charge (2026-09-22): capture an authorized, capturable hold. Idempotency-keyed by the payment's own id, so a
// concurrent capture of the same hold (two visits redeeming at once) gets Stripe's identical answer back, never a second
// charge. Marks the row paid on success so the caller can proceed straight to redemption. A hold that can no longer be
// captured is handled without throwing: re-check with Stripe rather than guess — someone else may have already captured
// it (converge, mark paid, do not treat as a loss), or the hold may genuinely be gone (mark expired: nothing was ever
// charged, nothing to refund). Any other failure (a transient error) changes nothing; the caller just reports the
// unchanged state and the guest can try again.
async function captureGuestHold(p: { id: string; stripe_payment_intent_id?: string | null }): Promise<boolean> {
  if (!p.stripe_payment_intent_id) return false;
  const markPaid = () => rest(`employer_payments?id=eq.${p.id}&status=eq.authorized`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }) });
  const cap = await stripe("POST", `/v1/payment_intents/${encodeURIComponent(p.stripe_payment_intent_id)}/capture`, new URLSearchParams(), `employer-guest-capture-${p.id}`);
  if (cap.ok && cap.data?.status === "succeeded") { await markPaid(); return true; }
  const check = await stripe("GET", `/v1/payment_intents/${encodeURIComponent(p.stripe_payment_intent_id)}`);
  if (check.ok && check.data?.status === "succeeded") { await markPaid(); return true; } // someone else's capture (or the webhook) won the race
  if (check.ok && check.data?.status === "canceled") {
    await rest(`employer_payments?id=eq.${p.id}&status=eq.authorized`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "expired" }) });
  }
  return false;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const action = typeof body.action === "string" ? body.action : "";

      if (action === "price") {
        const p = await guestPrice();
        return p ? json({ ok: true, amount_cents: p.amount_cents, currency: p.currency }) : json({ ok: false, error: "pricing_unavailable" }, 500);
      }

      // ---- request (claim token) ----
      if (action === "request") {
        if (typeof body.lookup_id !== "string" || !UUID.test(body.lookup_id) || typeof body.claim_token !== "string" || !TOKEN.test(body.claim_token)) return json({ ok: false, error: "unavailable" }, 409);
        const claimHash = await sha256Hex(body.claim_token.toLowerCase());
        const res = (await rpc("create_comparison_request", { p_lookup_id: body.lookup_id, p_method: "guest", p_employer_user: null, p_attestation: typeof body.attestation === "string" ? body.attestation : "", p_claim_hash: claimHash, p_document_id: typeof body.document_id === "string" && UUID.test(body.document_id) ? body.document_id : null }))?.[0];
        if (!res) return json({ ok: false, error: "request_failed" }, 500);
        // \`detail\` (why a candidate was unavailable) is never forwarded.
        if (!res.ok) {
          if (res.reason === "attestation_invalid") return json({ ok: false, error: "attestation_invalid" }, 400);
          if (res.reason === "document_required") return json({ ok: false, error: "document_required" }, 400);
          if (res.reason === "document_invalid") return json({ ok: false, error: "document_invalid" }, 400);
          if (res.reason === "rate_limited") return json({ ok: false, error: "rate_limited" }, 429);
          if (res.reason === "already_open") return json({ ok: false, error: "already_requested" }, 409);
          return json({ ok: false, error: "unavailable" }, 409);
        }
        // The claim token has done its one job.
        await rest(`employer_lookup_requests?id=eq.${body.lookup_id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ claim_token_hash: null }) });
        let notified = false;
        try {
          const n = await fetch(`${SUPABASE_URL}/functions/v1/candidate-comparison-requests`, {
            method: "POST", headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "notify_candidate", request_id: res.request_id }),
          });
          notified = n.ok && (await n.json().catch(() => ({})))?.sent === true;
        } catch (_e) { /* the sweep retries */ }
        return json({ ok: true, candidate_notified: notified });
      }

      // ---- everything below needs the emailed guest token ----
      const r = await requestByToken(body.token);
      if (!r) return json({ ok: false, error: "not_found" }, 404);
      const tokenHash = await sha256Hex(String(body.token).toLowerCase());
      const now = Date.now();

      const snapshotExists = async () => ((await rows(`comparison_snapshots?request_id=eq.${r.id}&select=id`)).length > 0);
      const payments = async () => await rows(`employer_payments?comparison_request_id=eq.${r.id}&select=id,status,stripe_checkout_session_id,stripe_payment_intent_id,refunded_at,redeemed_at,created_at&order=created_at.desc`);

      // Where this request stands, read from the rows passed in (never changes anything).
      const statusOf = async (r: any) => {
        const price = await guestPrice();
        const label = (await rows(`employer_lookup_requests?id=eq.${r.lookup_id}&select=candidate_label`))[0]?.candidate_label || "Candidate";
        let state: string;
        let windowEnds: string | null = null;
        if (r.first_delivered_at) {
          const open = r.status === "approved" && r.view_window_ends_at && new Date(r.view_window_ends_at).getTime() > now && await snapshotExists();
          state = open ? "open" : "closed";
          if (open) windowEnds = r.view_window_ends_at;
        } else if (r.status !== "approved" || !(await snapshotExists())) {
          state = "unavailable";
        } else {
          const ps = await payments();
          // 'authorized' (a placed hold, not yet captured) reads the same as 'created' to the guest: Stripe is/was doing
          // something with their card, keep checking. The genuine capture happens inside `enter`, not here.
          state = ps.some((p) => p.status === "paid" && !p.refunded_at) ? "ready_to_open"
            : ps.some((p) => p.status === "created" || p.status === "authorized") ? "payment_pending"
            : ps.some((p) => p.status === "needs_review") ? "payment_review" : "awaiting_payment";
        }
        // The kind of request is disclosed only once the candidate has approved it (before that, an employer must not be able to tell what sort of
        // account the candidate has). "unavailable" covers pending, declined and expired alike, so it never carries one. "closed" only happens after
        // the guest opened it, so they have already seen what it was.
        return { ok: true, state, kind: state === "unavailable" ? null : (r.kind || "resume_comparison"), candidate_label: label, window_ends_at: windowEnds, available_until: state === "unavailable" || state === "closed" || state === "open" ? null : r.snapshot_expires_at, price: price ? { amount_cents: price.amount_cents, currency: price.currency } : null };
      };

      // Read-only: never redeems anything.
      if (action === "status") return json(await statusOf(r));

      // A VISIT to the link (2026-09-21). Redemption follows the PAYMENT's real state, not a second click or one redirect finishing: every time the guest
      // lands on their link (straight back from Stripe, or any later visit) this checks whether a paid, unredeemed payment exists for the request and, if
      // so, redeems it right now (open_guest_comparison: the row is locked, the payment can be spent exactly once, the 30 minute window starts NOW) and
      // hands the result back in the same answer. Safe to call as often as you like:
      //   * nothing paid, or nothing left to serve -> only reports the state, changes nothing;
      //   * paid and unredeemed -> redeems once (a second, simultaneous visit is served the same snapshot with first_open false);
      //   * already redeemed and the 30 minute window is still open -> serves it again, free, without extending the window.
      if (action === "enter") {
        const windowOpen = (x: any) => !!x.first_delivered_at && x.status === "approved" && !!x.view_window_ends_at && new Date(x.view_window_ends_at).getTime() > now;
        let serve = false;
        if (r.status === "approved" && await snapshotExists()) {
          if (windowOpen(r)) {
            serve = true;
          } else if (!r.first_delivered_at) {
            const ps = await payments();
            const authorized = ps.find((p) => p.status === "authorized" && !p.refunded_at);
            // The genuine charge, made right now, at real redemption, never before. captureGuestHold changes nothing on
            // failure (hold already expired, or a transient error): the fallthrough below just reports the real state.
            const captured = authorized ? await captureGuestHold(authorized) : false;
            serve = captured || ps.some((p) => p.status === "paid" && !p.refunded_at && !p.redeemed_at);
          }
          // A simultaneous visit may have captured or redeemed it between the reads above: look again, so this visit is also served rather than told "open".
          if (!serve && !r.first_delivered_at) { const cur = await requestByToken(body.token); serve = !!cur && windowOpen(cur); }
        }
        if (serve) {
          const res = (await rpc("open_guest_comparison", { p_token_hash: tokenHash }))?.[0];
          if (res?.ok) {
            const snap = (await rows(`comparison_snapshots?request_id=eq.${r.id}&select=content,assembled_at`))[0];
            if (snap) {
              const fresh = (await requestByToken(body.token)) || r;
              return json({ ...(await statusOf(fresh)), delivered: { content: snap.content, assembled_at: snap.assembled_at, window_ends_at: res.window_ends_at, first_open: !!res.first_open } });
            }
          }
        }
        return json(await statusOf((await requestByToken(body.token)) || r));
      }

      if (action === "pay") {
        if (r.first_delivered_at || r.status !== "approved") return json({ ok: false, error: "not_available" }, 409);
        if (!r.snapshot_expires_at || new Date(r.snapshot_expires_at).getTime() - now < MIN_SNAPSHOT_LEFT_MS || !(await snapshotExists())) return json({ ok: false, error: "not_available" }, 409);
        const price = await guestPrice();
        if (!price || !(price.amount_cents > 0)) return json({ ok: false, error: "pricing_unavailable" }, 500);

        let ps = await payments();
        // An 'authorized' row is a live hold: never open a second one on top of it. The guest just needs to revisit the
        // link (enter captures it); there is nothing more for `pay` to do.
        if (ps.some((p) => (p.status === "paid" || p.status === "authorized") && !p.refunded_at)) return json({ ok: true, already_paid: true });
        if (ps.some((p) => p.status === "needs_review")) return json({ ok: false, error: "payment_review" }, 409);
        const live = ps.find((p) => p.status === "created");
        if (live) {
          // One payment per request: resume the hosted page if it is still open, otherwise retire it and start a fresh one.
          if (live.stripe_checkout_session_id) {
            const s = await stripe("GET", `/v1/checkout/sessions/${encodeURIComponent(live.stripe_checkout_session_id)}`);
            if (s.ok && s.data.status === "open" && s.data.url) return json({ ok: true, checkout_url: s.data.url, resumed: true });
            if (s.ok && s.data.status === "complete") return json({ ok: true, payment_pending: true });
          }
          await rest(`employer_payments?id=eq.${live.id}&status=eq.created`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "failed" }) });
        }

        const ins = await rest("employer_payments", {
          method: "POST", headers: { "Prefer": "return=representation" },
          body: JSON.stringify({ amount_cents: price.amount_cents, currency: price.currency, payer_email: r.requester_email, access_token_hash: await sha256Hex(randomHex(32)), lookup_id: r.lookup_id, comparison_request_id: r.id }),
        });
        if (ins.status === 409) return json({ ok: true, payment_pending: true }); // a simultaneous "pay" already created it
        if (!ins.ok) return json({ ok: false, error: "request_failed" }, 500);
        const pay = (await ins.json())[0];

        const form = new URLSearchParams();
        form.set("mode", "payment");
        form.set("customer_email", r.requester_email);
        form.set("client_reference_id", pay.id);
        // Authorize-then-capture (2026-09-22): a hold, not a charge. Card only (Apple Pay/Google Pay still work — Stripe
        // presents them as card), so the real charge is captured later, at genuine redemption, and an un-redeemed hold
        // simply expires on Stripe's own schedule (about 7 days, customer-initiated) with nothing ever charged.
        form.set("payment_method_types[0]", "card");
        form.set("payment_intent_data[capture_method]", "manual");
        // The price is ONE row (employer_pricing.guest_comparison) for both kinds; what a payment was FOR is recorded by its request (kind) and stamped
        // on the Stripe session and PaymentIntent, so a license report is never labeled as a comparison.
        const lr = r.kind === "license_report";
        for (const [k, v] of Object.entries({ product: "employer_guest_comparison", payment_id: pay.id, comparison_request_id: r.id, kind: r.kind || "resume_comparison" })) {
          form.set(`metadata[${k}]`, v);
          form.set(`payment_intent_data[metadata][${k}]`, v);
        }
        form.set("payment_intent_data[description]", lr ? "Verifi license status report (one-time view)" : "Verifi comparison access (one-time view)");
        form.set("line_items[0][quantity]", "1");
        form.set("line_items[0][price_data][currency]", price.currency);
        form.set("line_items[0][price_data][unit_amount]", String(price.amount_cents));
        form.set("line_items[0][price_data][product_data][name]", lr ? "Verifi license status report" : "Verifi comparison access");
        form.set("line_items[0][price_data][product_data][description]", lr
          ? "One-time view of a candidate's license status report, available for 30 minutes once opened. Not a subscription."
          : "One-time view of a candidate's verified record, available for 30 minutes once opened. Not a subscription.");
        form.set("success_url", `${RETURN_BASE}?comparison=${String(body.token).toLowerCase()}&payment=success`);
        form.set("cancel_url", `${RETURN_BASE}?comparison=${String(body.token).toLowerCase()}&payment=cancel`);
        const s = await stripe("POST", "/v1/checkout/sessions", form, `employer-guest-cmp-${pay.id}`);
        if (!s.ok || !s.data.url) {
          await rest(`employer_payments?id=eq.${pay.id}`, { method: "DELETE" });
          return json({ ok: false, error: "stripe_error" }, 502);
        }
        await rest(`employer_payments?id=eq.${pay.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ stripe_checkout_session_id: s.data.id }) });
        return json({ ok: true, checkout_url: s.data.url, amount_cents: price.amount_cents, currency: price.currency });
      }

      if (action === "open") {
        const res = (await rpc("open_guest_comparison", { p_token_hash: tokenHash }))?.[0];
        if (!res) return json({ ok: false, error: "request_failed" }, 500);
        if (!res.ok) {
          const map: Record<string, [number, string]> = {
            not_found: [404, "not_found"], payment_required: [402, "payment_required"], window_closed: [410, "window_closed"],
            not_available: [410, "not_available"], payment_unavailable: [409, "payment_unavailable"],
          };
          const [status, error] = map[res.reason] || [500, "request_failed"];
          return json({ ok: false, error }, status);
        }
        const snap = (await rows(`comparison_snapshots?request_id=eq.${r.id}&select=content,assembled_at`))[0];
        if (!snap) return json({ ok: false, error: "not_available" }, 410);
        return json({ ok: true, content: snap.content, assembled_at: snap.assembled_at, window_ends_at: res.window_ends_at, first_open: !!res.first_open });
      }

      if (action === "close") {
        const closed = await rpc("close_guest_comparison", { p_token_hash: tokenHash });
        return json({ ok: true, closed: closed === true });
      }

      return json({ ok: false, error: "unknown_action" }, 404);
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
