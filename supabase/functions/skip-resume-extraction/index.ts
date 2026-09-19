// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The real write behind candidate.html's "Continue without resume data" button (skipResumeConfirm,
// shown after an extraction failure). Before this function existed, that button was a pure
// client-side screen transition with no network call at all — confirmed directly against
// production: two real candidates (john.pirone@gmail.com, jpirone@yahoo.com) sit today with
// resume_documents.extraction_status = 'failed' and zero verification_items, with nothing in the
// database able to say whether they explicitly chose to continue or simply never came back. This
// closes that: marks the candidate's most recent resume_documents row with a real timestamp the
// moment they click through, so list-resume-extraction-failures (and anyone querying directly) can
// tell "explicitly continued anyway" from "never acknowledged" — see
// 20260906010000_resume_extraction_failure_visibility.sql for the column itself.
//
// Deliberately narrow: this does not touch extraction_status, does not retry anything, and does
// not attempt to fix the failure — it only records that the candidate chose to move on. Fixing the
// failure itself stays exactly what it already is (candidate emails the document directly),
// explicitly out of scope for this task.
//
// Best-effort by design, matching this codebase's existing convention for this kind of bookkeeping
// write (see resolve-session's last_seen_at update): candidate.html calls this after already
// transitioning the screen, not before, so a slow or failed request here never blocks or breaks
// the candidate's own flow. A missed write here costs staff a slightly stale signal, not a broken
// experience for the candidate.
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
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const docRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id&order=uploaded_at.desc&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!docRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const docRows = await docRes.json();
      const doc = docRows[0];
      if (!doc) {
        // No resume_documents row at all for this candidate — real dead end found live (2026-09-07,
        // investigating a session-refresh bug report): resume_documents.original_storage_path is NOT
        // NULL, so there is no row here to attach continued_without_data_at to, which meant a
        // candidate who never uploaded anything and clicked through anyway had this choice recorded
        // NOWHERE — checkResumeFlowIncomplete's `if (!data.resume_document) return true` branch
        // stayed permanently "incomplete" and re-routed them to resumeConfirm on every future login,
        // confirmed by reproducing it directly with a fresh test candidate. Recorded on `candidates`
        // instead, the one row that's guaranteed to already exist at this point.
        const candPatchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({ continued_without_resume_at: new Date().toISOString() }),
          },
        );
        if (!candPatchRes.ok) {
          const errText = await candPatchRes.text();
          return new Response(JSON.stringify({ ok: false, error: "update_failed", detail: errText }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, marked: true, marked_on: "candidates" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${doc.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ continued_without_data_at: new Date().toISOString() }),
        },
      );
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, marked: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
