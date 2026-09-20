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
// ---------------------------------------------------------------------------------------------------
// ONE LIVE SUBSCRIPTION PER CANDIDATE (2026-09-20).
// "Change plan or payment method" used to start a brand-new subscription-mode Checkout with no look at what the candidate
// already had. Completing it made test-stripe-webhook overwrite candidates.stripe_subscription_id with the NEW subscription
// and never touch the old one, so the old one kept billing with nothing in the database pointing at it. Two guards now:
//   1. HERE, before a session is created: if the candidate already has a live Stripe subscription (checked with Stripe itself,
//      not just the database column), then
//        * a plain "start a subscription" request is REFUSED with 409 already_subscribed (the screen was stale: a second
//          Checkout would double-bill someone who did not mean to change anything), and
//        * an explicit change_plan request is allowed and the session is stamped metadata[replaces_subscription] = the live
//          subscription's id. The old subscription is NOT cancelled here: cancelling before the new payment succeeds would
//          leave a candidate who abandons Checkout with no plan at all.
//      If Stripe cannot be asked whether a subscription is live, the request fails (502) rather than guessing.
//   2. In test-stripe-webhook, when the replacement payment actually completes: the old subscription is cancelled as part
//      of recording the new one (and any other subscription the row pointed at, which also covers two Checkouts open at once).
// Every new subscription is also stamped with candidate_id and product (subscription_data[metadata]) so any subscription can
// be attributed to a candidate directly in Stripe.
// ---------------------------------------------------------------------------------------------------
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const RETURN_BASE_URL = "https://alpha.applitrust.com/candidate.html";

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (candidate-session pass, 2026-09-19).
// This function used to act on whatever candidate_id the request body named, with no check that the caller was that
// candidate (or anyone at all beyond holding the PUBLIC anon key), so anyone who knew or guessed an id could read or
// change that account. It now requires one of:
//   * the service-role key as the bearer token (our own functions calling each other; exact match, constant-time); or
//   * the candidate's OWN live session: the session_token candidate.html holds, checked on every call against
//     candidate_sessions (hashed, unrevoked, unexpired) and required to belong to the candidate_id being acted on.
// Anything else is the same 401 whether the token was missing, wrong, expired, revoked or someone else's.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function authSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function authIsServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY);
}
async function authIsCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
  const r = await fetch(`${AUTH_SB_URL}/rest/v1/candidate_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
async function authGateCandidate(req: Request, body: any): Promise<Response | null> {
  const cid = typeof body?.candidate_id === "string" ? body.candidate_id : "";
  if (authIsServiceCaller(req)) return null;
  if (cid && await authIsCandidateSession(body, cid)) return null;
  return UNAUTHORIZED();
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const { candidate_id, billing_cycle, product, change_plan } = await req.json();
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

      // Does this candidate already have a live subscription? Ask Stripe about the one the database names.
      const sbHeaders = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
      const candRes = await fetch(`${AUTH_SB_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}&select=stripe_subscription_id,stripe_subscription_cancelled_at`, { headers: sbHeaders });
      if (!candRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const candRow = (await candRes.json())[0];
      if (!candRow) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let liveSubscriptionId: string | null = null;
      if (candRow.stripe_subscription_id && !candRow.stripe_subscription_cancelled_at) {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(candRow.stripe_subscription_id)}`, {
          headers: { "Authorization": "Bearer " + STRIPE_SECRET_KEY },
        });
        if (subRes.status === 404) {
          liveSubscriptionId = null; // Stripe has no such subscription: nothing to replace
        } else if (!subRes.ok) {
          return new Response(JSON.stringify({ ok: false, error: "subscription_check_failed", status: subRes.status }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          const sub = await subRes.json();
          if (LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) liveSubscriptionId = sub.id;
        }
      }
      if (liveSubscriptionId && change_plan !== true) {
        return new Response(JSON.stringify({ ok: false, error: "already_subscribed" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = new URLSearchParams();
      body.set("mode", "subscription");
      body.set("client_reference_id", candidate_id);
      body.set("success_url", `${RETURN_BASE_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
      body.set("cancel_url", `${RETURN_BASE_URL}?checkout=cancel`);
      body.set("metadata[product]", productKey);
      if (liveSubscriptionId) body.set("metadata[replaces_subscription]", liveSubscriptionId);
      body.set("subscription_data[metadata][candidate_id]", candidate_id);
      body.set("subscription_data[metadata][product]", productKey);
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
        replacesSubscription: liveSubscriptionId,
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
