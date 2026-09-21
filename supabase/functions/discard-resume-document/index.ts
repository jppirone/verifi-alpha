// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 1 (2026-09-11 status-check session, CRITICAL) — the real backend behind "reject this /
// start over" on resumeConfirm. Real sequence reproduced this week: a candidate saw content
// misclassified into needs_review and wanted to reject/restart, but Confirm was the only
// available forward action on the screen — forced to click Confirm just to escape a bad state,
// not because the data was approved. This closes that gap: a candidate can now discard the
// current resume_document and everything extracted from it BEFORE ever confirming, and get a
// genuinely clean slate to upload a different file into.
//
// Deletes real rows, not a soft flag — discard_resume_document (see its own migration) does the
// atomic multi-table delete (work_history_items/education_items/certification_items/skill_items/
// candidate_freeform_sections, then resume_documents itself), scoped to (resume_document_id,
// candidate_id) so a candidate can only ever discard their own document. Storage objects
// (original_storage_path / sanitized_render_path) are deleted here, best-effort, immediately
// after — a Postgres function can't reach Supabase Storage directly (see the RPC's own note), and
// a failure here doesn't fail the discard itself: the DB rows are already gone, which is what
// actually matters for "restarts extraction cleanly on the new upload" — an orphaned storage
// object with no DB row pointing to it is inert, not a functional bug.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";

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
      const { candidate_id, resume_document_id } = await req.json();
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

      // Look up storage paths BEFORE the RPC deletes the row — nothing to read them from after.
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${resume_document_id}&candidate_id=eq.${candidate_id}&select=original_storage_path,sanitized_render_path,confirmed_at,kind`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      const lookupRows = lookupRes.ok ? await lookupRes.json() : [];
      const doc = lookupRows[0];
      if (!doc) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Resume resubmission, Stage 1 (2026-09-21): this used to delete ANY of the candidate's documents, including a CONFIRMED one (its items and file)
      // whenever no queue row pointed at it (the verification_items.bundle_id foreign key was the only thing standing in the way). A confirmed
      // document is the record of what the candidate submitted and what was verified: it is never discarded from here. A resubmission attempt is
      // discarded through resume-resubmission's own cancel, which also closes the attempt.
      if (doc.confirmed_at) {
        return new Response(JSON.stringify({ ok: false, error: "confirmed_document_protected" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (doc.kind === "resubmission") {
        return new Response(JSON.stringify({ ok: false, error: "use_resubmission_cancel" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/discard_resume_document`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ p_resume_document_id: resume_document_id, p_candidate_id: candidate_id }),
      });
      if (!rpcRes.ok) {
        const errText = await rpcRes.text();
        return new Response(JSON.stringify({ ok: false, error: "discard_failed", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const paths = [doc.original_storage_path, doc.sanitized_render_path].filter(Boolean);
      if (paths.length) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
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
