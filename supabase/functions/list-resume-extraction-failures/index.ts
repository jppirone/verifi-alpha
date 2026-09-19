// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real, minimal staff visibility for a confirmed-live gap: a candidate whose resume extraction
// fails and who never reaches the verification queue had zero trace visible to staff before this —
// confirmed by querying production directly and finding two real candidates in exactly this state
// (john.pirone@gmail.com, jpirone@yahoo.com), and by confirming staff.html never read
// resume_documents at all. Deliberately narrow, per this task's own scope: a list of candidates
// whose most recent resume_documents row failed AND who have zero verification_items rows at all
// (nothing ever got far enough to reach the staff queue) — not a UI for fixing the extraction
// failure itself, and not a manual-entry/side-by-side editing interface. That stays exactly what it
// already is: the candidate emails the document directly. This is only the "staff knows a failure
// happened" half of the gap.
//
// continued_without_data_at (see 20260906010000_resume_extraction_failure_visibility.sql and
// skip-resume-extraction) is returned as-is, null or set, so staff can tell "candidate explicitly
// continued anyway" from "never acknowledged the failure at all" — both need outreach, but they're
// no longer indistinguishable.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// STAFF ROLE POLICY (2026-09-19). Until now this function only checked that the caller held SOME live staff session; the
// role (staff_users.role: 'admin' | 'worker') was fetched and never used, so every worker could do everything an admin could.
// The role is now enforced HERE, on the server, on every call, from the database row (never from the request, the session row
// or staff.html):
//   * admin  - everything.
//   * worker - only the queue items ASSIGNED TO THEM (verification_items.assigned_to = their staff_users.name): read them,
//     update them (status, notes, follow-up, automated-check text, correction apply/decline), add timeline entries, re-run a
//     license check on them, open their candidate's original document. A worker cannot reassign, cannot read or change any
//     other item, and cannot list staff or the extraction-failure report. Registry look-ups (the five verify-* adapters) carry
//     no candidate data and stay open to any staff session.
//   * an unknown role is treated as worker (least privilege); only the exact string 'admin' is privileged.
// A caller outside its role gets 403 {ok:false,error:"forbidden"} (401 stays "no live session"), so staff.html can tell
// "your session ended" from "not yours".
// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (staff/internal endpoint auth pass, 2026-09-19).
// This function used to have no caller check beyond the platform's own key check, which the PUBLIC anon key (embedded in
// candidate.html and staff.html) passes: anyone could call it. It now requires one of:
//   * the service-role key as the bearer token (what our own functions send when they call each other; exact match,
//     constant-time compare), where the function allows internal callers; or
//   * a live STAFF session: the staff_session_token staff.html already holds from staff-confirm-login, checked on every call
//     against staff_sessions (hashed, unrevoked, unexpired) and resolved to a staff_users row. Identity is never taken from
//     the request body.
// Anything else is the same 401 whether the token was missing, wrong, expired or revoked.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type AuthCaller = { kind: "service" } | { kind: "staff"; id: string; email: string; name: string; role: string };
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
async function authenticateStaffOrService(req: Request, body: any, allow: { staff: boolean; service: boolean }): Promise<AuthCaller | null> {
  if (allow.service) {
    const h = req.headers.get("authorization") || "";
    const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (t && AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY)) return { kind: "service" };
  }
  if (allow.staff) {
    const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
    if (tok.length >= 20 && tok.length <= 200) {
      const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
      const sRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: rest });
      const sess = sRes.ok ? (await sRes.json())[0] : null;
      if (sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now()) {
        const uRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`, { headers: rest });
        const u = uRes.ok ? (await uRes.json())[0] : null;
        if (u) return { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role };
      }
    }
  }
  return null;
}
const FORBIDDEN = () => new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const isAdminCaller = (c: AuthCaller) => c.kind === "service" || (c.kind === "staff" && c.role === "admin");
const workerName = (c: AuthCaller): string | null => (c.kind === "staff" && c.role !== "admin" ? c.name : null);
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    let authBody: any = {};
    try { authBody = await req.clone().json(); } catch (_e) { authBody = {}; }
    const caller = await authenticateStaffOrService(req, authBody, { staff: true, service: true });
    if (!caller) return UNAUTHORIZED();
    if (!isAdminCaller(caller)) return FORBIDDEN(); // outreach report over candidates with no queue items: not tied to any worker's assigned items
    try {
      const headers = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

      const docsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?select=id,candidate_id,uploaded_at,continued_without_data_at&extraction_status=eq.failed&order=uploaded_at.desc`,
        { headers },
      );
      if (!docsRes.ok) {
        const detail = await docsRes.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const docs = await docsRes.json();
      if (docs.length === 0) {
        return new Response(JSON.stringify({ ok: true, items: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // One row per candidate — their most recent failed document, since docs is already ordered
      // newest-first and this keeps only the first (most recent) row seen per candidate_id. Rows
      // with no candidate_id at all (a real case found live: an upload attempt that never got tied
      // to an account) are skipped here — there's no candidate to reach out to, and leaving one in
      // would poison every "in.(...)" filter built from candidateIds below with a literal "null",
      // which fails the whole request rather than just that one row (confirmed live: this silently
      // zeroed out candidateName/candidateEmail/candidatePhone for every real candidate, not just
      // the null one, until this filter was added).
      const latestByCandidate = new Map<string, any>();
      for (const d of docs) {
        if (!d.candidate_id) continue;
        if (!latestByCandidate.has(d.candidate_id)) latestByCandidate.set(d.candidate_id, d);
      }
      const candidateIds = Array.from(latestByCandidate.keys());

      // Excluded entirely once a candidate has ANY verification_items row — the moment even one
      // real item exists, they've reached the staff queue some other way (a later successful
      // upload, opting into a category, etc.) and this list's whole point — nothing to see — no
      // longer applies to them.
      const vqRes = await fetch(
        `${SUPABASE_URL}/rest/v1/verification_items?select=candidate_id&candidate_id=in.(${candidateIds.map(encodeURIComponent).join(",")})`,
        { headers },
      );
      const vqRows = vqRes.ok ? await vqRes.json() : [];
      const hasQueueItems = new Set(vqRows.map((r: any) => r.candidate_id));

      const relevantIds = candidateIds.filter((id) => !hasQueueItems.has(id));
      if (relevantIds.length === 0) {
        return new Response(JSON.stringify({ ok: true, items: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?select=id,email,phone,full_name,first_name,last_name&id=in.(${relevantIds.map(encodeURIComponent).join(",")})`,
        { headers },
      );
      const candRows = candRes.ok ? await candRes.json() : [];
      const candidateById = new Map(candRows.map((c: any) => [c.id, c]));

      const items = relevantIds.map((id) => {
        const doc = latestByCandidate.get(id);
        const cand: any = candidateById.get(id) || {};
        return {
          candidateId: id,
          // Same first_name/last_name-preferred, full_name-fallback convention as
          // list-verification-items — first_name/last_name is what a real signup writes now,
          // full_name is what every candidate who signed up before that change has instead.
          candidateName: [cand.first_name, cand.last_name].filter(Boolean).join(" ") || cand.full_name || null,
          candidateEmail: cand.email || null,
          candidatePhone: cand.phone || null,
          uploadedAt: doc.uploaded_at,
          continuedWithoutDataAt: doc.continued_without_data_at,
        };
      });

      return new Response(JSON.stringify({ ok: true, items }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
