// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item C (2026-09-08 regression session): the write side of the new, optional employer/
// certification contact-details screen (see the migration's own header for the full field list
// and why they exist). Handles BOTH a real submission (work_history/certifications carry candidate-
// entered values) and an explicit Skip (both arrays empty) — either way, this is the one place
// resume_documents.employer_contact_resolved_at gets set, the real "this screen was reached and
// resolved" signal candidate.html's session-routing logic depends on (see
// checkEmployerContactIncomplete's own header there).
//
// Every field here is candidate-stated and never validated against anything — confirmed real by
// design, not an oversight: this is a hint for staff outreach, not a claim staff verify. Ownership
// is still checked on every write (.eq("candidate_id", candidate_id) on every row) — the same
// discipline confirm-resume-data's own header established, so a candidate can never write into
// another candidate's rows even with a guessed id.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type WorkHistoryContact = { id: string; employer_name_override?: string; employer_location_override?: string; contact_phone?: string; contact_name?: string };
type CertificationContact = { id: string; verification_link?: string; contact_phone?: string };

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
      const body = await req.json();
      const candidate_id: string | undefined = body.candidate_id;
      const resume_document_id: string | undefined = body.resume_document_id;
      const work_history: WorkHistoryContact[] = Array.isArray(body.work_history) ? body.work_history : [];
      const certifications: CertificationContact[] = Array.isArray(body.certifications) ? body.certifications : [];

      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!resume_document_id || typeof resume_document_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "resume_document_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      for (const w of work_history) {
        if (!w.id) continue;
        const res = await fetch(`${SUPABASE_URL}/rest/v1/work_history_items?id=eq.${encodeURIComponent(w.id)}&candidate_id=eq.${encodeURIComponent(candidate_id)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            employer_name_override: w.employer_name_override || null,
            employer_location_override: w.employer_location_override || null,
            contact_phone: w.contact_phone || null,
            contact_name: w.contact_name || null,
          }),
        });
        if (!res.ok) {
          const detail = await res.text();
          return new Response(JSON.stringify({ ok: false, error: "work_history_update_failed", detail, item_id: w.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const rows = await res.json().catch(() => []);
        if (!Array.isArray(rows) || rows.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "work_history_item_not_found_for_candidate", item_id: w.id }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      for (const c of certifications) {
        if (!c.id) continue;
        const res = await fetch(`${SUPABASE_URL}/rest/v1/certification_items?id=eq.${encodeURIComponent(c.id)}&candidate_id=eq.${encodeURIComponent(candidate_id)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            verification_link: c.verification_link || null,
            contact_phone: c.contact_phone || null,
          }),
        });
        if (!res.ok) {
          const detail = await res.text();
          return new Response(JSON.stringify({ ok: false, error: "certification_update_failed", detail, item_id: c.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const rows = await res.json().catch(() => []);
        if (!Array.isArray(rows) || rows.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "certification_item_not_found_for_candidate", item_id: c.id }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const resolveRes = await fetch(`${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${encodeURIComponent(resume_document_id)}&candidate_id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ employer_contact_resolved_at: new Date().toISOString() }),
      });
      if (!resolveRes.ok) {
        const detail = await resolveRes.text();
        return new Response(JSON.stringify({ ok: false, error: "resolve_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const resolveRows = await resolveRes.json().catch(() => []);
      if (!Array.isArray(resolveRows) || resolveRows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "resume_document_not_found_for_candidate" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
