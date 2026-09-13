// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 regression session): the real wiring for candidate.html's Subscription tab
// upgrade flow, replacing this function's original HIP-POCKET FEASIBILITY TEST shape (see git
// history for that version's own header — it proved the raw mechanism only: fixed $10 one-time
// charge, placeholder success/cancel URLs that don't resolve, not parameterized by any real
// candidate). That mechanism (direct Stripe REST calls via fetch, sk_test_ key already configured
// in this project's secrets, real test-mode Checkout Sessions) is reused here, not rebuilt — only
// the request shape and destination URLs changed.
//
// mode=subscription, not mode=payment (the original test used payment): candidate.html's own
// Subscription tab copy promises real recurring billing ("$4.99/mo" or "$50/yr", "Payment is
// attempted 7 days before renewal") — a one-time charge dressed up as a subscription would be its
// own new dishonesty. Stripe Checkout supports inline recurring price_data for subscription mode
// (no pre-created Price object in the Dashboard required), same "no SDK, plain REST" pattern as
// before.
//
// client_reference_id = candidate_id is what lets test-stripe-webhook (see that function's own
// header) attribute a completed session back to a real candidate row without a second round trip —
// Stripe's own documented mechanism for exactly this "attach a known internal id to a session" case.
//
// Real, resolvable destination pages (alpha.applitrust.com/candidate.html), not the original
// verifi-test.example.com placeholders — candidate.html's own componentDidMount now handles
// ?checkout=success / ?checkout=cancel on return (see handleCheckoutReturn there).
//
// Scope note, confirmed before writing this: only the Subscription tab's already-logged-in upgrade
// path is wired to real Stripe. The tiers/interstitial screen's OWN paid-tier selection (reached
// mid-signup, before any session token is ever persisted — confirmed live, applySignupConfirmation
// never calls localStorage.setItem for a session token, only applySession does) still uses the
// existing simulated modal: a full-page redirect to Stripe at that point would strand the candidate
// with nothing to resolve back into on return. Real-Stripe-izing that path needs the signup session-
// token gap fixed first — flagged, not fixed today.
//
// SUPERSEDED by Item C's own header just below (2026-09-08 session, redirect revision): that gap
// was closed the same night — the signup-time paid-tier selection now calls this same function too.
// Left here for the historical record of why the earlier pop-up-window design existed at all.
//
// Item 10 (2026-09-13 live-testing session): `product` distinguishes which recurring price this
// session is for — 'resume_pro' (default, the pre-existing Verifi Pro upgrade, unchanged pricing/
// name) vs 'license_tracking' (the new license-only signup's mandatory subscription, see
// candidate.html's licenseBilling screen). Both still use the exact same mechanism confirmed working
// end-to-end tonight (mode=subscription, inline price_data, no pre-created Stripe Price/Product
// needed in the Dashboard) — this is additive branching inside the one existing function, not a
// parallel integration. `metadata[product]` is set on the session so test-stripe-webhook can tell
// the two apart when the payment completes and knows which candidate column to patch — see that
// function's own header. License-tracking pricing ($9.99/mo, $99/yr) is a PLACEHOLDER, explicitly
// flagged as such in candidate.html's own licenseBilling copy — not a validated real-world price,
// same "simulate verification complete" honesty posture as the KYC step it follows.
const PRODUCTS: Record<string, { monthly: string; annual: string; nameMonthly: string; nameAnnual: string }> = {
  resume_pro: { monthly: "499", annual: "5000", nameMonthly: "Verifi Pro (monthly)", nameAnnual: "Verifi Pro (annual)" },
  license_tracking: { monthly: "999", annual: "9900", nameMonthly: "Verifi License Tracking (monthly)", nameAnnual: "Verifi License Tracking (annual)" },
};
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const RETURN_BASE_URL = "https://alpha.applitrust.com/candidate.html";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, billing_cycle, product } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const productKey = product === "license_tracking" ? "license_tracking" : "resume_pro";
      const productConfig = PRODUCTS[productKey];
      const cycle = billing_cycle === "annual" ? "annual" : "monthly";
      const interval = cycle === "annual" ? "year" : "month";
      const unitAmount = cycle === "annual" ? productConfig.annual : productConfig.monthly;
      const productName = cycle === "annual" ? productConfig.nameAnnual : productConfig.nameMonthly;

      const body = new URLSearchParams();
      body.set("mode", "subscription");
      body.set("client_reference_id", candidate_id);
      body.set("success_url", `${RETURN_BASE_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
      body.set("cancel_url", `${RETURN_BASE_URL}?checkout=cancel`);
      body.set("metadata[product]", productKey);
      body.set("line_items[0][quantity]", "1");
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", unitAmount);
      body.set("line_items[0][price_data][recurring][interval]", interval);
      body.set("line_items[0][price_data][product_data][name]", productName);

      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + STRIPE_SECRET_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: "stripe_error", status: res.status, detail: data }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        sessionId: data.id,
        url: data.url,
        mode: data.mode,
        livemode: data.livemode,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
