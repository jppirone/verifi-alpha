// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const FIELD_MAP = {
  type: "type",
  claim: "claim",
  received: "received",
  desired: "desired",
  followUp: "follow_up",
  note: "note",
  internalNote: "internal_note",
  automatedCheck: "automated_check",
  status: "status",
  assignedTo: "assigned_to",
  correctionRequested: "correction_requested",
  correctionNote: "correction_note",
  correctionField: "correction_field",
  correctionValue: "correction_value",
};
const DATE_COLUMNS = new Set(["received", "desired", "follow_up"]);
// The statuses staff.html offers (STATUS_OPTIONS). Nothing else is ever a valid status, for any role (this used to accept any string).
const STATUS_VALUES = new Set(["New", "In Progress", "Awaiting Response", "Needs Reconciliation", "Confirmed", "Discrepancy", "Unable to Verify"]);
// What a worker may change on an item assigned to them: exactly what staff.html lets a worker do. assignedTo, type, received, desired
// and the candidate-side correction fields (correctionNote/correctionField, written by submit-candidate-correction-response) are not in it.
const WORKER_PATCH_FIELDS = new Set(["status", "note", "internalNote", "followUp", "automatedCheck", "claim", "correctionValue", "correctionRequested"]);

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
    try {
      const { id, patch } = await req.json();
      if (!id || typeof id !== "string" || !patch || typeof patch !== "object") {
        return new Response(JSON.stringify({ ok: false, error: "id and patch are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const scopedTo = workerName(caller);
      if (scopedTo) {
        for (const k of Object.keys(patch)) if (FIELD_MAP[k] && !WORKER_PATCH_FIELDS.has(k)) return FORBIDDEN();
      }
      if (Object.prototype.hasOwnProperty.call(patch, "status") && !STATUS_VALUES.has((patch as any).status)) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_status" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const dbPatch = {};
      for (const [k, v] of Object.entries(patch)) {
        const col = FIELD_MAP[k];
        if (!col) continue;
        dbPatch[col] = DATE_COLUMNS.has(col) && v === "" ? null : v;
      }
      if (Object.keys(dbPatch).length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "no valid fields in patch" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // A worker's update is CONDITIONAL on the item still being assigned to them, in the same statement (no check-then-write gap):
      // zero rows updated means "not yours" (or not there), which a worker is told the same way.
      const updateUrl = SUPABASE_URL + "/rest/v1/verification_items?id=eq." + encodeURIComponent(id) + (scopedTo ? "&assigned_to=eq." + encodeURIComponent(scopedTo) : "");
      const updateRes = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Prefer": "return=representation",
        },
        body: JSON.stringify(dbPatch),
      });
      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return new Response(JSON.stringify({ ok: false, error: "not_found", detail: errText }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = await updateRes.json();
      if (!Array.isArray(rows) || rows.length !== 1) {
        if (scopedTo) return FORBIDDEN();
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
