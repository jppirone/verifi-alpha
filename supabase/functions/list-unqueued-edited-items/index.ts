// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const REST_HEADERS = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
};

// Item G, Part 2 (2026-09-26): the deliberately separate, on-demand surface for edited-but-never-
// queued items -- see list_unqueued_edited_items()'s own migration header for why this can't just be
// folded into list-verification-items' normal join (there is no verification_items row for these at
// all, by design, since confirm-resume-data only ever queues a category the candidate opted into). A
// spot-check surface, not a backlog: never counted in, and structurally independent of, the normal
// queue's own counts/metrics. staff.html only calls this the first time a staff member deliberately
// opens the "Edited, not submitted" toggle -- never eagerly, never on every queue poll.
//
// Admin-only, unlike list-verification-items (which workers can call scoped to their own assignments):
// these items were never assigned to anyone (they never entered the queue in the first place), so
// there's no "my items" scope for a worker to see here -- same admin-only precedent already
// established for staff-employer-documents ("For abuse investigation (admins only)") and the
// extraction-failure report.
//
// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (same pattern as list-verification-items' own header, copied verbatim).
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
async function authenticateStaffOrService(req: Request, body: any): Promise<AuthCaller | null> {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (t && AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY)) return { kind: "service" };
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
  return null;
}
const FORBIDDEN = () => new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const isAdminCaller = (c: AuthCaller) => c.kind === "service" || (c.kind === "staff" && c.role === "admin");

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    let authBody: any = {};
    try { authBody = await req.clone().json(); } catch (_e) { authBody = {}; }
    const caller = await authenticateStaffOrService(req, authBody);
    if (!caller) return UNAUTHORIZED();
    if (!isAdminCaller(caller)) return FORBIDDEN();
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_unqueued_edited_items`, {
        method: "POST", headers: { ...REST_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rawItems: any[] = await res.json();
      const items = rawItems.map((r: any) => ({
        sourceItemId: r.source_item_id,
        category: r.category,
        claim: r.claim || "(no content)",
        editedFieldNames: r.edited_fields || [],
        candidateId: r.candidate_id,
        candidateName: r.candidate_name || "—",
        candidateEmail: r.candidate_email || null,
      }));
      return new Response(JSON.stringify({ ok: true, items }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
