// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Verification-status persistence fix (2026-09-18): the real backend write path for candidate.html's
// phone / KYC / email-SMS cross-validation confirmation actions, none of which have ever written
// anywhere server-side before this -- confirmed live by tracing every one of confirmPhoneModal,
// confirmCvPhoneEntry, confirmKycModal, confirmCvEmailCode, and confirmCvSmsCode, all of which only
// ever called this.setState(...). See this session's memory (verifi-extraction-nondeterminism-open-item
// is unrelated; the relevant one is the verification-status-persistence investigation) for the full
// architecture confirmation this was scoped against.
//
// One shared, single-purpose function for all three event kinds rather than three near-duplicate
// files -- modeled on save-header-preferences/set-discoverable's own "narrow, not a general
// profile-update endpoint" shape, just parameterized by which single column gets a timestamp,
// since a phone/KYC/cross-validation confirmation is the same conceptual write (record that a
// specific verification type completed, right now) three times over, not three different concepts.
//
// kyc_verified_at is REUSED here, not new -- it already exists (Item 10 migration, license-only
// signup-time write). This is a SECOND write path onto the same column, for full-resume accounts,
// post-signup, from the KYC modal -- confirmed with the user before building that this is the
// intended design (same underlying meaning for both account types; "reverify" just overwrites it).
const VERIFICATION_TYPE_TO_COLUMN: Record<string, string> = {
  phone: "phone_verified_at",
  kyc: "kyc_verified_at",
  cross_validation: "cross_validation_completed_at",
};

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
      const { candidate_id, verification_type, verified_phone_number } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Marks the candidate's own verification steps done: only the candidate's own live session (or an internal caller).
      if (!(authIsServiceCaller(req) || await authIsCandidateSession(authBody, candidate_id))) return UNAUTHORIZED();
      const column = VERIFICATION_TYPE_TO_COLUMN[verification_type];
      if (!column) {
        return new Response(JSON.stringify({ ok: false, error: "verification_type_must_be_phone_kyc_or_cross_validation" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // phone verification also needs to durably record WHICH number was verified, not just when --
      // a timestamp alone can't answer "does the candidate's currently-entered number still match
      // what was last verified," which the client depends on throughout. Required specifically for
      // this event kind, not the other two, which have no analogous "which value" question.
      if (verification_type === "phone" && (typeof verified_phone_number !== "string" || !verified_phone_number.trim())) {
        return new Response(JSON.stringify({ ok: false, error: "verified_phone_number_required_for_phone_verification" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const nowIso = new Date().toISOString();
      const patch: Record<string, string> = { [column]: nowIso };
      if (verification_type === "phone") patch.verified_phone_number = verified_phone_number.trim();

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify(patch),
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

      return new Response(JSON.stringify({
        ok: true,
        verification_type,
        [column]: rows[0][column],
        ...(verification_type === "phone" ? { verified_phone_number: rows[0].verified_phone_number } : {}),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
