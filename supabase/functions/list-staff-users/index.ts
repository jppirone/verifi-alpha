// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real dead end this closes (2026-09-07 wiring audit, item 12): staff.html's "Assign to" dropdown
// was a hardcoded fake roster (WORKERS = ['Jordan Lee', 'Priya Nair', 'Sam Okafor']) despite the
// real staff_users table (see 20260906000000_staff_auth.sql) already existing and already backing
// real staff login. This is the one new read staff.html needed to stop using the fake roster.
//
// Returns every staff_users row, not just role='worker' — confirmed live before building this that
// the real roster today is a single admin account (no worker rows exist yet), so a worker-only
// filter would leave the dropdown with zero options. Assignment has never actually been role-gated
// (admins can already do everything workers can in this queue), so there's no real reason to exclude
// admins from being assignable too.
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
  fetch: withSupabase({ auth: "none" }, async (_req, _ctx) => {
    if (_req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    let authBody: any = {};
    try { authBody = await _req.clone().json(); } catch (_e) { authBody = {}; }
    const caller = await authenticateStaffOrService(_req, authBody, { staff: true, service: true });
    if (!caller) return UNAUTHORIZED();
    if (!isAdminCaller(caller)) return FORBIDDEN(); // the staff roster is only needed to assign work, which only an admin does
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?select=id,name,role&order=name.asc`, {
        headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      return new Response(JSON.stringify({
        ok: true,
        staff: rows.map((r: any) => ({ id: r.id, name: r.name, role: r.role })),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
