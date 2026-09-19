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
    const onlyAssignedTo = workerName(caller); // null for admin/service: everything
    try {
      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,received,desired,follow_up,note,internal_note,automated_check,status,assigned_to,correction_requested,correction_note,correction_field,correction_value,source_item_id,verification_item_timeline(event_date,actor,action,note),candidates(id,full_name,first_name,last_name,email,phone)&order=id.asc&verification_item_timeline.order=event_date.asc" + (onlyAssignedTo ? "&assigned_to=eq." + encodeURIComponent(onlyAssignedTo) : "");
      const res = await fetch(url, { headers: REST_HEADERS });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();

      // Item C (2026-09-08 regression session): "Surface a known contact/entity hint in the staff
      // queue item detail view" — batch-fetched here, keyed by type since source_item_id is
      // polymorphic (see the migration's own header): a "Job Experience" row's source_item_id is a
      // real work_history_items.id, a "Certification" row's is a real certification_items.id.
      // Older rows (confirmed before source_item_id existed) simply have it null and get no hint —
      // an honest gap, not backfilled with a guess.
      const workHistoryIds = [...new Set(rows.filter((r: any) => r.type === "Job Experience" && r.source_item_id).map((r: any) => r.source_item_id))];
      const certIds = [...new Set(rows.filter((r: any) => r.type === "Certification" && r.source_item_id).map((r: any) => r.source_item_id))];

      // type "License" rows point at license_items (see verify-license): the stored state / number /
      // last automatic outcome staff need in order to re-run the check against real data instead of
      // hand-typed search terms.
      const licenseIds = [...new Set(rows.filter((r: any) => r.type === "License" && r.source_item_id).map((r: any) => r.source_item_id))];
      const licenseRows: any[] = licenseIds.length
        ? await fetch(`${SUPABASE_URL}/rest/v1/license_items?id=in.(${licenseIds.join(",")})&select=id,state,state_source,verification_outcome,verification_reason,verification_source,verified_at,certification_items(name,issuing_body,license_number)`, { headers: REST_HEADERS }).then((r) => r.ok ? r.json() : [])
        : [];
      const licenseById = new Map(licenseRows.map((l) => [l.id, l]));

      const [workHistoryContacts, certContacts] = await Promise.all([
        workHistoryIds.length
          ? fetch(`${SUPABASE_URL}/rest/v1/work_history_items?id=in.(${workHistoryIds.join(",")})&select=id,company,employer_name_override,employer_location_override,contact_phone,contact_name`, { headers: REST_HEADERS }).then((r) => r.ok ? r.json() : [])
          : Promise.resolve([]),
        certIds.length
          ? fetch(`${SUPABASE_URL}/rest/v1/certification_items?id=in.(${certIds.join(",")})&select=id,verification_link,contact_phone`, { headers: REST_HEADERS }).then((r) => r.ok ? r.json() : [])
          : Promise.resolve([]),
      ]);
      const workHistoryContactById = new Map((workHistoryContacts as any[]).map((w) => [w.id, w]));
      const certContactById = new Map((certContacts as any[]).map((c) => [c.id, c]));

      const items = rows.map((r: any) => {
        const wc = r.type === "Job Experience" && r.source_item_id ? workHistoryContactById.get(r.source_item_id) : null;
        const cc = r.type === "Certification" && r.source_item_id ? certContactById.get(r.source_item_id) : null;
        const employerNameOverride = wc?.employer_name_override || null;
        const employerLocationOverride = wc?.employer_location_override || null;
        const contactPhone = wc?.contact_phone || cc?.contact_phone || null;
        const contactName = wc?.contact_name || null;
        const verificationLink = cc?.verification_link || null;
        // Item 13 (2026-09-11 status-check session): the real employer name to run an automated
        // Sunbiz check against, computed once here rather than in staff.html — candidate-supplied
        // employer_name_override (see hasContactHint's own comment: candidate-stated, staff outreach
        // only) is more likely to be current/accurate than whatever the resume parse landed on, so it
        // wins when present; company (the resume-parsed original) is the fallback, never the other
        // way around.
        const employerNameResolved = employerNameOverride || wc?.company || null;
        return {
        id: r.id,
        type: r.type,
        claim: r.claim,
        received: r.received,
        desired: r.desired,
        followUp: r.follow_up,
        note: r.note,
        internalNote: r.internal_note,
        automatedCheck: r.automated_check,
        licenseData: r.type === "License" && r.source_item_id ? (() => {
          const l = licenseById.get(r.source_item_id);
          return l ? {
            id: l.id, state: l.state, licenseNumber: l.certification_items?.license_number ?? null, licenseName: l.certification_items?.name ?? null, issuingBody: l.certification_items?.issuing_body ?? null,
            stateSource: l.state_source, outcome: l.verification_outcome, reason: l.verification_reason,
            source: l.verification_source, verifiedAt: l.verified_at,
          } : null;
        })() : null,
        status: r.status,
        assignedTo: r.assigned_to,
        correctionRequested: r.correction_requested,
        correctionNote: r.correction_note,
        correctionField: r.correction_field,
        correctionValue: r.correction_value,
        // first_name/last_name is what a real signup writes now (see confirm-verification);
        // full_name is what every candidate who signed up before that change has instead. Neither
        // one alone covers every candidate the staff queue needs to show, so this concatenates
        // first+last when present and only falls back to full_name for the rows that predate it.
        candidateName: r.candidates
          ? ([r.candidates.first_name, r.candidates.last_name].filter(Boolean).join(" ") || r.candidates.full_name || null)
          : null,
        candidateEmail: r.candidates ? r.candidates.email : null,
        candidatePhone: r.candidates ? r.candidates.phone : null,
        // Real dead end this closes (2026-09-07 wiring audit, item 9): the queue list view showed
        // only candidateName — two real test accounts with the same name were visually
        // indistinguishable there. candidateEmail already covers the normal case; this id is only
        // the fallback for the rare row with a candidate but no email on file.
        candidateId: r.candidates ? r.candidates.id : null,
        // Item C (2026-09-08): candidate-stated, never validated — a hint for staff outreach, not a
        // verification claim (see the migration's own header). hasContactHint lets the list/detail
        // view flag a row with something to show without every consumer re-deriving the same check.
        employerNameOverride, employerLocationOverride, contactPhone, contactName, verificationLink,
        employerNameResolved,
        hasContactHint: !!(employerNameOverride || employerLocationOverride || contactPhone || contactName || verificationLink),
        timeline: (r.verification_item_timeline || []).map((t: any) => ({
          date: t.event_date,
          actor: t.actor,
          action: t.action,
          note: t.note,
        })),
        };
      });
      return new Response(JSON.stringify({ ok: true, items }), {
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
