// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Subscription cancellation gap (2026-09-18): before this function existed, nothing in this app
// ever called Stripe to cancel a real subscription — set-candidate-tier's own header already said
// so plainly for the downgrade-to-Free path, and deactivate-account never touched Stripe at all.
// A candidate who downgraded or deleted their account while paid kept their real Stripe
// subscription running (and billing) indefinitely, completely decoupled from what the app showed.
//
// This function only ever ASKS Stripe to cancel — real confirmation that it actually happened is
// test-stripe-webhook's new customer.subscription.deleted branch (see that function's own header),
// not this response. Same "don't trust the request, trust the webhook" split test-stripe-checkout/
// test-stripe-webhook already draw for the forward (subscribe) direction — a 200 here means Stripe
// accepted the cancel request, not that stripe_subscription_cancelled_at is set yet.
//
// Takes candidate_id (not a subscription id directly) and looks up stripe_subscription_id itself —
// same "server derives the sensitive/internal id server-side" shape as every other function here
// that takes candidate_id rather than trusting a client-supplied Stripe id. Called unconditionally
// by both confirmDowngrade and deactivateAccount regardless of the candidate's real tier — a
// candidate with no stripe_subscription_id on file (never subscribed via Stripe, or already
// cancelled) is a genuine no-op, not an error, so callers don't need to special-case "were they
// actually paid" before calling this.
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (staff/internal endpoint auth pass, 2026-09-19).
// This function used to take a candidate_id from the request body and act on it with no check that the caller was that
// candidate (or anyone at all beyond holding the PUBLIC anon key), so anyone who knew an id could act on that account. It
// now requires one of:
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
  if (tok.length < 20 || tok.length > 200) return false;
  const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
  const r = await fetch(`${AUTH_SB_URL}/rest/v1/candidate_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Cancelling a real Stripe subscription: the candidate's own live session, or an internal caller. One legitimate
      // case has no live session: the account-deactivation flow calls this AFTER deactivate-account has revoked every
      // session (see candidate.html's deactivateAccount), so an account that is already scheduled for deletion may be
      // cancelled by id alone. deactivate-account itself now needs the candidate's session, so an outsider cannot use that
      // route to unlock this one.
      if (!(authIsServiceCaller(req) || await authIsCandidateSession(authBody, candidate_id))) {
        const dRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}&select=deletion_scheduled_at`, {
          headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        });
        const dRow = dRes.ok ? (await dRes.json())[0] : null;
        if (!dRow || !dRow.deletion_scheduled_at) return UNAUTHORIZED();
      }

      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}&select=stripe_subscription_id`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!candRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const candRows = await candRes.json();
      const subscriptionId: string | null = candRows[0]?.stripe_subscription_id ?? null;
      if (!candRows.length) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!subscriptionId) {
        return new Response(JSON.stringify({ ok: true, cancelled: false, reason: "no_subscription_on_file" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Immediate cancellation (DELETE), not cancel_at_period_end — this is always a candidate-
      // initiated "stop this now" action (a confirmed downgrade click, or account deletion), never a
      // scheduled future cancellation, so there's no case here where letting billing continue to the
      // end of the current period is the right default.
      const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + STRIPE_SECRET_KEY },
      });
      const data = await res.json();
      if (!res.ok) {
        // A subscription already cancelled directly in Stripe (or never existed under this id) comes
        // back as a real Stripe error, not a silent success — surfaced honestly rather than assumed
        // fine, same posture as test-stripe-checkout's own stripe_error branch.
        return new Response(JSON.stringify({ ok: false, error: "stripe_error", status: res.status, detail: data }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, cancelled: true, stripeStatus: data.status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
