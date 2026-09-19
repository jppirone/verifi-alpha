// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 session): read side of the Content Manager's named-summary-versions feature —
// real backend for what used to be seedSummaries(), a pure client fixture (two hardcoded literals,
// reset every reload, see candidate_summary_versions' own migration header for the full history).
//
// Auto-seed-on-first-visit: a candidate's very first call here (zero rows in
// candidate_summary_versions) creates ONE default version for them, seeded from the real,
// already-wired resume-extracted summary (candidate_freeform_sections where section_type =
// 'summary') — never blank, never invented, same document-provenance discipline as everywhere
// else in this build: the starting point traces back to something real from the uploaded
// document. origin = 'resume_extracted' marks this row's content as having started there — set
// once, at this insert, and never touched again by any later edit (see the migration's own
// header for why that matters). If this candidate genuinely has no extracted summary (skipped
// resume upload, or the resume had no professional-summary section), the default version is
// still created — an honest empty starting point, same convention already used elsewhere in this
// build for "nothing was actually printed" (e.g. education/work_history location) — rather than
// fabricating placeholder text just to have something to show.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SB_HEADERS = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

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
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const listRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_summary_versions?candidate_id=eq.${encodeURIComponent(candidate_id)}&order=created_at.asc`,
        { headers: SB_HEADERS },
      );
      if (!listRes.ok) {
        const detail = await listRes.text();
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let summaries = await listRes.json();

      if (Array.isArray(summaries) && summaries.length === 0) {
        // First visit — seed the one default version from the real extracted summary.
        const freeformRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidate_freeform_sections?candidate_id=eq.${encodeURIComponent(candidate_id)}&section_type=eq.summary&select=content&limit=1`,
          { headers: SB_HEADERS },
        );
        let extractedContent = "";
        if (freeformRes.ok) {
          const rows = await freeformRes.json();
          if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].content === "string") {
            extractedContent = rows[0].content;
          }
        }

        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/candidate_summary_versions`, {
          method: "POST",
          headers: {
            ...SB_HEADERS,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            candidate_id,
            name: "Default summary",
            content: extractedContent,
            origin: "resume_extracted",
            partner_key: "",
          }),
        });
        if (!insertRes.ok) {
          const detail = await insertRes.text();
          return new Response(JSON.stringify({ ok: false, error: "seed_failed", detail }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        summaries = await insertRes.json();
      }

      return new Response(JSON.stringify({ ok: true, summaries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
