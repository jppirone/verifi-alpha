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

// GUEST PAY-ONCE (2026-09-19). No employer account or session: the browser that starts a payment is handed a random
// access token (only its SHA-256 is stored on the payment row), which is just enough to check that ONE payment's status
// and, in the comparison flow, to redeem it once. Authorization here is possession of that token, never an id alone.
//
// The charge is a Stripe Checkout Session in payment mode, which creates a PaymentIntent underneath; the PaymentIntent id,
// the charge and its receipt URL are what the webhook stores (employer-stripe-events), and "paid" is decided only by the
// webhook, from Stripe's own event with a matching amount, never by the browser returning from Stripe. Card details are
// only ever entered on Stripe's hosted page, so nothing card-shaped touches this app.
//
// Receipts: this app sends its own receipt email (amount, date, reference, Stripe's hosted receipt link) when the payment is
// confirmed, identically in test and live mode. Stripe's automatic receipt emails are deliberately NOT also requested, so a
// live payment cannot produce two receipts (and Stripe sends none in test mode anyway).
//
// Actions (POST {action, ...}):
//   pricing  -> the current one-time price (public)
//   create   -> {payer_email, lookup_id?}: creates the payment + Checkout Session, returns the hosted checkout URL and the
//               guest token (shown once)
//   status   -> {payment_id, guest_token}: the payment's status; wrong token = the same 404 as an unknown payment
//
// lookup_id is optional and NOT yet bound to an approval: the Tier 2 request flow will bind a payment to an approved
// request. If supplied it must be a completed Tier 1 lookup that matched a candidate (checked, but nothing more is
// revealed about it).
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const JSON_H = { ...REST, "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/;
const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 200;
const RETURN_BASE = "https://alpha.applitrust.com/employer.html";

const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...JSON_H, ...(init.headers || {}) } });
async function sha256Hex(raw: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const action = typeof body.action === "string" ? body.action : "";

      const priceRes = await rest("employer_pricing?key=eq.guest_comparison&select=amount_cents,currency");
      const price = priceRes.ok ? (await priceRes.json())[0] : null;
      if (!price) return json({ ok: false, error: "pricing_unavailable" }, 500);

      if (action === "pricing") return json({ ok: true, amount_cents: price.amount_cents, currency: price.currency, placeholder: true });

      if (action === "status") {
        if (typeof body.payment_id !== "string" || !UUID.test(body.payment_id) || typeof body.guest_token !== "string" || body.guest_token.length < 20 || body.guest_token.length > 200) return json({ ok: false, error: "not_found" }, 404);
        const r = await rest(`employer_payments?id=eq.${body.payment_id}&access_token_hash=eq.${await sha256Hex(body.guest_token)}&select=status,amount_cents,currency,paid_at,receipt_url,redeemed_at,refunded_at`);
        const p = r.ok ? (await r.json())[0] : null;
        if (!p) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true, status: p.status, amount_cents: p.amount_cents, currency: p.currency, paid_at: p.paid_at, redeemed: !!p.redeemed_at, refunded: !!p.refunded_at, receipt_url: p.status === "paid" ? p.receipt_url : null });
      }

      if (action === "create") {
        const email = typeof body.payer_email === "string" ? body.payer_email.trim().toLowerCase().slice(0, 254) : "";
        if (!EMAIL.test(email)) return json({ ok: false, error: "payer_email_invalid" }, 400);
        let lookupId: string | null = null;
        if (body.lookup_id !== undefined && body.lookup_id !== null) {
          if (typeof body.lookup_id !== "string" || !UUID.test(body.lookup_id)) return json({ ok: false, error: "lookup_invalid" }, 400);
          const lk = await rest(`employer_lookup_requests?id=eq.${body.lookup_id}&result_exists=eq.true&used_at=not.is.null&select=id`);
          if (!lk.ok || !(await lk.json())[0]) return json({ ok: false, error: "lookup_invalid" }, 400);
          lookupId = body.lookup_id;
        }

        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const [perEmail, global] = await Promise.all([
          rest(`employer_payments?payer_email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_EMAIL_PER_HOUR + 1}`),
          rest(`employer_payments?created_at=gte.${encodeURIComponent(since)}&select=id&limit=${GLOBAL_PER_HOUR + 1}`),
        ]);
        if (!perEmail.ok || !global.ok) return json({ ok: false, error: "request_failed" }, 500);
        if ((await perEmail.json()).length >= PER_EMAIL_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);
        if ((await global.json()).length >= GLOBAL_PER_HOUR) return json({ ok: false, error: "busy" }, 429);

        const guestToken = randomToken();
        const ins = await rest("employer_payments", {
          method: "POST", headers: { "Prefer": "return=representation" },
          body: JSON.stringify({ amount_cents: price.amount_cents, currency: price.currency, payer_email: email, access_token_hash: await sha256Hex(guestToken), lookup_id: lookupId }),
        });
        if (!ins.ok) return json({ ok: false, error: "request_failed" }, 500);
        const pay = (await ins.json())[0];

        const form = new URLSearchParams();
        form.set("mode", "payment");
        form.set("customer_email", email);
        form.set("client_reference_id", pay.id);
        form.set("metadata[product]", "employer_guest_comparison");
        form.set("metadata[payment_id]", pay.id);
        form.set("payment_intent_data[metadata][product]", "employer_guest_comparison");
        form.set("payment_intent_data[metadata][payment_id]", pay.id);
        form.set("payment_intent_data[description]", "Verifi comparison access (one-time view)");
        form.set("line_items[0][quantity]", "1");
        form.set("line_items[0][price_data][currency]", price.currency);
        form.set("line_items[0][price_data][unit_amount]", String(price.amount_cents));
        form.set("line_items[0][price_data][product_data][name]", "Verifi comparison access");
        form.set("line_items[0][price_data][product_data][description]", "One-time view of a candidate's verified record next to your copy. Not a subscription.");
        form.set("success_url", `${RETURN_BASE}?payment=success`);
        form.set("cancel_url", `${RETURN_BASE}?payment=cancel`);
        const sRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `employer-guest-${pay.id}` },
          body: form.toString(),
        });
        const session = await sRes.json();
        if (!sRes.ok || !session.url) {
          await rest(`employer_payments?id=eq.${pay.id}`, { method: "DELETE" });
          return json({ ok: false, error: "stripe_error" }, 502);
        }
        await rest(`employer_payments?id=eq.${pay.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ stripe_checkout_session_id: session.id }) });
        return json({ ok: true, payment_id: pay.id, guest_token: guestToken, checkout_url: session.url, amount_cents: price.amount_cents, currency: price.currency });
      }

      return json({ ok: false, error: "unknown_action" }, 404);
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
