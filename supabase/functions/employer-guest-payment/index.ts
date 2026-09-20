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
// 2026-09-20: "create" is RETIRED. A guest payment is now created only by employer-comparison ("pay"), bound to ONE approved
// comparison request; this endpoint keeps "pricing" and "status". (The old unbound create is refused with 410.)
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

      // RETIRED 2026-09-20 (comparison Stage 3): a guest payment now exists only bound to ONE approved comparison request, and is created by
      // employer-comparison ("pay"), not here. An unbound payment could never be redeemed for anything, so creating one is refused.
      if (action === "create") return json({ ok: false, error: "use_comparison_flow" }, 410);

      return json({ ok: false, error: "unknown_action" }, 404);
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
