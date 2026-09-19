// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item C (2026-09-08 session): read-only tier check, keyed by candidate_id alone — no session
// token required. Originally built for the signup-time paid-tier pop-up checkout, which couldn't
// reuse resolve-session's own re-check loop (resolve-session needs a session token; a pop-up-based
// flow only ever has the candidate_id in memory). candidate.html no longer calls this for that
// original purpose: that flow was switched from a pop-up to a full-page redirect (see
// startRealCheckout's own header) once it turned out a session token genuinely does exist by that
// point in signup, so it now reuses resolve-session's own retry loop directly, same as every other
// real checkout return in this file.
//
// Subscription cancellation gap (2026-09-18), Step 3: exactly the same id-only need reappeared for
// a second real reason — deactivateAccount's own real-time billing-cancellation confirmation has to
// keep polling AFTER deactivate-account has already revoked every session this candidate holds (see
// that function's own header), so resolve-session is no longer usable at that point even though it
// still has resumeCandidateId sitting in local memory. Left deployed exactly as originally built
// (candidate_id in, real data out, no session token required) — stripe_subscription_cancelled_at
// added alongside tier for this new caller, not a new function, since the shape ("read one real
// column by candidate_id, no session") is identical.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      let billingFactOnly = false;
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) {
        // Regression fix (2026-09-19, found while walking the login flow): candidate.html's account-deactivation screen polls this
        // for stripe_subscription_cancelled_at AFTER deactivate-account has revoked every session (see checkCandidateBillingCancelled,
        // "session-free" by design), so gating it on a live session made a paid candidate's goodbye screen end "unconfirmed" even
        // though the cancel succeeded. Like cancel-stripe-subscription, an account that is already scheduled for deletion is answered
        // without a session, but ONLY with that one billing fact (no tier, no license fact); anything else is still 401.
        const cid = typeof authBody?.candidate_id === "string" ? authBody.candidate_id : "";
        const dRes = cid ? await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(cid)}&select=deletion_scheduled_at`, {
          headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        }) : null;
        const dRow = dRes && dRes.ok ? (await dRes.json())[0] : null;
        if (!dRow || !dRow.deletion_scheduled_at) return authDenied;
        billingFactOnly = true;
      }
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}&select=tier,stripe_subscription_cancelled_at,license_subscription_started_at`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      const candidate = rows[0];
      if (!candidate) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (billingFactOnly) {
        return new Response(JSON.stringify({ ok: true, stripe_subscription_cancelled_at: candidate.stripe_subscription_cancelled_at }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, tier: candidate.tier, stripe_subscription_cancelled_at: candidate.stripe_subscription_cancelled_at, license_subscription_started_at: candidate.license_subscription_started_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
