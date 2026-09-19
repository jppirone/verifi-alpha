// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 regression session): the self-service half of real tier state — a downgrade
// to Free doesn't involve Stripe at all (no charge to reverse in test mode; a real integration
// would cancel the Stripe subscription here too, out of scope for the alpha's test-mode wiring).
// Upgrading to Paid is deliberately NOT done through this function — that only ever happens via a
// real completed Stripe Checkout session, written by test-stripe-webhook once payment_status is
// actually "paid" (see that function's own header). This function accepts either direction in its
// request shape for symmetry, but candidate.html only ever calls it with tier: 'free' — flagged
// here so a future caller doesn't assume this is a legitimate way to grant Paid without payment.
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
      const { candidate_id, tier } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (tier !== "free" && tier !== "paid") {
        return new Response(JSON.stringify({ ok: false, error: "tier_must_be_free_or_paid" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Auth (2026-09-19): this endpoint used to grant Paid to anyone who named a candidate_id, contradicting its own
      // header (Paid only ever comes from the Stripe webhook). Now: Paid only with the service-role key (nothing
      // legitimate calls it that way today; the webhook writes the tier itself), and a downgrade to Free only from the
      // candidate's own live session.
      const isService = authIsServiceCaller(req);
      if (tier === "paid" ? !isService : !(isService || await authIsCandidateSession(authBody, candidate_id))) return UNAUTHORIZED();

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ tier, tier_updated_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, tier: rows[0].tier }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
