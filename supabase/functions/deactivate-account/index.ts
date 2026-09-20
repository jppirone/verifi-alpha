// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real dead end this closes (2026-09-07 wiring audit, item 5): candidate.html's confirmDeactivate()
// was 100% local React state — clicking "deactivate" never told the server anything, so the
// account stayed fully logged in, fully accessible, on every device, indefinitely. This function
// is the real backend: it sets candidates.deletion_scheduled_at (see this migration's own header,
// 20260907020000_account_deactivation.sql, for why that's a "when," not the purge date itself) and
// revokes EVERY session this candidate holds, not just the calling device's — deliberately broader
// than logout's single-token_hash revoke, because deactivation has to end access everywhere at
// once, the same moment, not just on the device that clicked the button.
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
      // Only the candidate themself (their own live session) or an internal service caller may deactivate an account.
      if (!(authIsServiceCaller(req) || await authIsCandidateSession(authBody, candidate_id))) return UNAUTHORIZED();

      const now = new Date();

      const candRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ deletion_scheduled_at: now.toISOString() }),
      });
      if (!candRes.ok) {
        const detail = await candRes.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const candRows = await candRes.json();
      if (!Array.isArray(candRows) || candRows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Revoke by candidate_id, every still-active session — deliberately broader than logout's
      // single-token_hash PATCH (see logout's own header). "Still active" (revoked_at is null)
      // rather than an unconditional PATCH of all rows so an already-revoked/expired session's
      // revoked_at timestamp isn't overwritten with a later, misleading one.
      const sessRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_sessions?candidate_id=eq.${encodeURIComponent(candidate_id)}&revoked_at=is.null`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ revoked_at: now.toISOString() }),
        },
      );
      if (!sessRes.ok) {
        const detail = await sessRes.text();
        return new Response(JSON.stringify({ ok: false, error: "session_revoke_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // The database trigger has just deleted every employer document of this candidate's requests (rows, immediately) and queued the files.
      // Run the purge now so the files are gone within seconds instead of at the next 15-minute run. Best effort: the cron run still catches them.
      try {
        const sec = await fetch(`${SUPABASE_URL}/rest/v1/internal_job_secrets?name=eq.purge_resume_storage&select=value`, { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
        const secret = sec.ok ? ((await sec.json())[0]?.value ?? "") : "";
        if (secret) {
          await fetch(`${SUPABASE_URL}/functions/v1/purge-resume-storage`, {
            method: "POST", signal: AbortSignal.timeout(15000),
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "x-purge-secret": secret },
            body: JSON.stringify({ mode: "queue" }),
          });
        }
      } catch (_e) { /* the scheduled purge still runs */ }

      const deletionDate = new Date(now);
      deletionDate.setDate(deletionDate.getDate() + 30);

      return new Response(JSON.stringify({
        ok: true,
        deletion_scheduled_at: now.toISOString(),
        deletion_date: deletionDate.toISOString().slice(0, 10),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
