// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

// set-atid-preferences (AU, October 19, 2026): saves the candidate's three "include my ATID" export choices on their account.
//   POST { candidate_id, session_token, atid_export_pdf_line?, atid_export_pdf_hidden?, atid_export_json?, atid_employer_visible? }
// At least one of the flags must be present; each flag that is present must be a real boolean (anything else is a 400 and NOTHING is written). Only the flags
// that were sent are written, so saving one box can never write a stale copy of another. The answer carries all three saved values, which the page then shows.
// Auth: the candidate's OWN live session, or the service-role key (same gate as set-discoverable); anything else is the same 401.
// These choices only shape the candidate's own PDF and JSON downloads. They are never read by an employer-facing path.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The three export choices (AU) and the employer switch (AR). The employer switch is saved here too, not only by set-discoverable: set-discoverable has to be sent the "Allow lookup"
// value as well, so the page could save it only after the privacy settings had loaded and could in principle write a stale Allow lookup. This function needs neither.
const FLAGS = ["atid_export_pdf_line", "atid_export_pdf_hidden", "atid_export_json", "atid_employer_visible"] as const;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!SUPABASE_SERVICE_ROLE_KEY && safeEqual(t, SUPABASE_SERVICE_ROLE_KEY);
}
async function isCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const rest = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions?token_hash=eq.${await sha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      const body = await req.json().catch(() => ({}));
      const candidateId = typeof body?.candidate_id === "string" ? body.candidate_id : "";
      if (!(isServiceCaller(req) || (candidateId && await isCandidateSession(body, candidateId)))) return json({ ok: false, error: "unauthorized" }, 401);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateId)) return json({ ok: false, error: "candidate_id_invalid" }, 400);

      const patch: Record<string, boolean> = {};
      for (const f of FLAGS) {
        if (!(f in body) || body[f] === undefined) continue;
        if (typeof body[f] !== "boolean") return json({ ok: false, error: "bad_flag", flag: f }, 400);   // booleans only; nothing is written
        patch[f] = body[f];
      }
      if (Object.keys(patch).length === 0) return json({ ok: false, error: "no_flag" }, 400);

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Prefer": "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return json({ ok: false, error: "update_failed" }, 500);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return json({ ok: false, error: "candidate_not_found" }, 404);
      return json({
        ok: true,
        atid_export_pdf_line: rows[0].atid_export_pdf_line === true,
        atid_export_pdf_hidden: rows[0].atid_export_pdf_hidden === true,
        atid_export_json: rows[0].atid_export_json === true,
        atid_employer_visible: rows[0].atid_employer_visible === true,
      });
    } catch (_e) {
      return json({ ok: false, error: "unhandled" }, 500);
    }
  }),
};
