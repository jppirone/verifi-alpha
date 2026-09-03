// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, stripe-signature",
};

// HIP-POCKET FEASIBILITY TEST — companion to test-stripe-checkout. Proves the other half of the
// mechanism: does this project actually learn a payment succeeded (not just that a checkout page
// loaded)? Real Stripe webhook signature verification, implemented directly against the documented
// algorithm (Web Crypto HMAC-SHA256) rather than pulling in the Stripe SDK, same lightweight
// pattern as everything else tonight:
//   Stripe-Signature header shape: "t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]"
//   signed payload = "<timestamp>.<raw request body>" (the EXACT raw bytes, not re-serialized
//   JSON — this must be read via req.text() before any JSON.parse, or the signature will never
//   match even with a correct secret)
//   expected v1 = hex(HMAC-SHA256(STRIPE_WEBHOOK_SECRET, signed payload))
// STRIPE_WEBHOOK_SECRET (whsec_...) comes from registering this deployed function's URL as a
// webhook endpoint in the Stripe Dashboard (test mode) — Stripe generates that secret per
// endpoint, it isn't chosen or predictable in advance.
//
// No live-mode key or endpoint anywhere in this project — checked before any of this was built.
//
// RESULT — DOCUMENTED SUCCESS. Confirmed with a real event, not a synthetic "send test event":
// completing a real Checkout Session in a browser with Stripe's 4242 4242 4242 4242 test card
// produced a genuine checkout.session.completed webhook call from Stripe's own servers
// (User-Agent: "Stripe/1.0", source IP owned by Amazon/Stripe infra), which this function verified
// and parsed correctly. The exact response body Stripe recorded for that delivery (visible in its
// own dashboard, Delivered, HTTP 200):
//   {"ok":true,"verified":true,"signatureTimestamp":"1788441531",
//    "eventId":"evt_1UBaXXRqPebINCzH0eLhc1Lc","eventType":"checkout.session.completed",
//    "livemode":false,"checkoutSession":{"id":"cs_test_a1a4PP...","paymentStatus":"paid",
//    "amountTotal":1000,"currency":"usd","customerEmail":"test@verifi-test.example.com"}}
// Every field matches the real checkout exactly (amount, currency, the email typed into the
// Checkout form). Separately confirmed the negative case: completing a second session with
// Stripe's decline test card (4000 0000 0000 0002) produced a real "Your credit card was
// declined" error on the Checkout page and — checked via this function's own invocation log, not
// assumed — zero webhook deliveries, since a session that never completes never fires this event.
//
// One real setup gotcha worth flagging, not a code problem: Supabase's own "Verify JWT with legacy
// secret" project-level setting is ON by default for a new function and sits in front of this
// function's own code — a Stripe webhook call carries no Supabase auth header at all, so with that
// setting on, Stripe's requests were rejected before ever reaching the signature-verification code
// below. Had to be turned off explicitly in this function's Settings tab (labeled "Recommended:
// OFF with JWT and custom auth logic in your function code" — which is exactly this function's
// situation). Easy to miss the first time; the failure mode if missed would be a 401 with no
// application-level error message explaining why.

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<{ valid: boolean; timestamp?: string }> {
  const parts: Record<string, string[]> = {};
  for (const piece of sigHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const k = piece.slice(0, eq);
    const v = piece.slice(eq + 1);
    (parts[k] ||= []).push(v);
  }
  const t = parts["t"]?.[0];
  const v1s = parts["v1"] || [];
  if (!t || v1s.length === 0) return { valid: false };

  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computedHex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { valid: v1s.includes(computedHex), timestamp: t };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (!STRIPE_WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: "STRIPE_WEBHOOK_SECRET not configured yet" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sigHeader = req.headers.get("stripe-signature");
    const rawBody = await req.text(); // raw, unparsed — required for signature verification
    if (!sigHeader) {
      return new Response(JSON.stringify({ ok: false, error: "missing_stripe_signature_header" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { valid, timestamp } = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return new Response(JSON.stringify({ ok: false, error: "signature_verification_failed" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json_body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const summary: Record<string, unknown> = {
      ok: true,
      verified: true,
      signatureTimestamp: timestamp,
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      summary.checkoutSession = {
        id: session.id,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        currency: session.currency,
        customerEmail: session.customer_details?.email ?? null,
      };
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }),
};
