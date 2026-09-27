// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

// Overlapping employment detection (2026-09-27): Design_Principles.docx P142 / Business_Model_Decision_
// Log.docx Decision 40. This is the ONLY way an overlap hold ever clears -- neither the candidate's
// explanation nor their choice to ignore does it (see confirm-resume-data/resume-resubmission's own
// create_work_overlap_hold call). A dedicated endpoint rather than a generic verification_items status
// change: "resolved" doesn't fit the Confirmed/Discrepancy/etc. vocabulary that endpoint enforces, and
// resolving needs to update work_overlap_holds itself (resolved_at/resolved_by/resolution_note), not
// just the linked queue row -- see resolve_work_overlap_hold's own header in the migration.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST_HEADERS = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Same staff-session auth as every other staff-facing function on this project (list-verification-items,
// update-verification-item) -- resolving a hold is a human staff action, so service-role callers are not
// accepted here (there is no staff_id to attribute the resolution to).
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
type StaffCaller = { id: string; name: string; role: string };
async function authenticateStaff(body: any): Promise<StaffCaller | null> {
  const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
  if (tok.length < 20 || tok.length > 200) return null;
  const sRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: REST_HEADERS });
  const sess = sRes.ok ? (await sRes.json())[0] : null;
  if (!sess || sess.revoked_at || new Date(sess.expires_at).getTime() <= Date.now()) return null;
  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,name,role`, { headers: REST_HEADERS });
  const u = uRes.ok ? (await uRes.json())[0] : null;
  return u ? { id: u.id, name: u.name, role: u.role } : null;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const FORBIDDEN = () => new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      const body = await req.json().catch(() => ({}));
      const caller = await authenticateStaff(body);
      if (!caller) return UNAUTHORIZED();

      const { hold_id, note } = body as { hold_id?: string; note?: string };
      if (!hold_id || typeof hold_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "hold_id_required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Worker role policy, same shape as update-verification-item: a worker may only resolve a hold
      // whose linked queue item is assigned to them; admin resolves anything.
      if (caller.role !== "admin") {
        const holdRes = await fetch(`${SUPABASE_URL}/rest/v1/work_overlap_holds?id=eq.${hold_id}&select=verification_item_id`, { headers: REST_HEADERS });
        const hold = holdRes.ok ? (await holdRes.json())[0] : null;
        if (!hold) return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        if (hold.verification_item_id) {
          const qiRes = await fetch(`${SUPABASE_URL}/rest/v1/verification_items?id=eq.${hold.verification_item_id}&select=assigned_to`, { headers: REST_HEADERS });
          const qi = qiRes.ok ? (await qiRes.json())[0] : null;
          if (!qi || qi.assigned_to !== caller.name) return FORBIDDEN();
        } else {
          return FORBIDDEN(); // no queue row to be assigned to -- a worker has nothing to claim this against
        }
      }

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_work_overlap_hold`, {
        method: "POST",
        headers: { ...REST_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ p_hold_id: hold_id, p_staff_id: caller.id, p_note: typeof note === "string" ? note.slice(0, 2000) : null }),
      });
      if (!rpcRes.ok) {
        const detail = (await rpcRes.text().catch(() => "")).slice(0, 300);
        return new Response(JSON.stringify({ ok: false, error: "resolve_failed", detail }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const resolved = await rpcRes.json();
      if (!resolved) {
        return new Response(JSON.stringify({ ok: false, error: "already_resolved" }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }),
};
