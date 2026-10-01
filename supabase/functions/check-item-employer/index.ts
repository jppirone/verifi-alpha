import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { authenticateRegistryCaller } from "../_shared/registry/auth.ts";
import { employerCheckFromKb, employerFromWorkHistory, mergeAutomatedCheck, notCheckedPatch } from "../_shared/kb/queue-check.ts";
import type { EmployerCheckPatch } from "../_shared/kb/queue-check.ts";

// Employer check for ONE verification-queue item (2026-10-01): the connection between the verification queue and the Knowledge Base.
//
// POST {verification_item_id, staff_session_token?}   (service-role bearer, or a live staff session; a worker only for items assigned to them)
//   -> reads the item's work-history entry (employer name + location), asks kb-verify-business (existence, automatically; a lookup is never made without
//      a stated state), and writes the result ONTO the queue item: employer_check (json), operating_status, operating_confirmation_required, and one
//      "Employer check ..." line in automated_check (an earlier such line is replaced, so re-running is safe).
//   -> a result whose operating_status_confirmation_required is true (the registry publishes no status: Pennsylvania) sets
//      operating_confirmation_required, which routes the item to staff confirmation of OPERATING STATUS. Existence is unaffected: the item still records the
//      employer as found/verified.
// Only "Job Experience" items are checked. Called after the queue commit by confirm-resume-data and resume-resubmission (background, like verify-license).
// Nothing is written to the candidate-visible timeline: an employer's registry status is staff-only.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const caller = await authenticateRegistryCaller(req, body, SUPABASE_URL, SERVICE_KEY);
    if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
    const itemId = typeof body.verification_item_id === "string" ? body.verification_item_id : "";
    if (!itemId || itemId.length > 80) return json({ ok: false, error: "verification_item_id_required" }, 400);

    try {
      const ir = await fetch(`${SUPABASE_URL}/rest/v1/verification_items?id=eq.${encodeURIComponent(itemId)}&select=id,type,source_item_id,assigned_to,automated_check`, { headers: H });
      const item = ir.ok ? (await ir.json())[0] : null;
      if (!item) return json({ ok: false, error: "not_found" }, 404);
      // a worker may only act on items assigned to them (same rule as every other staff endpoint)
      if (caller.kind === "staff" && caller.role !== "admin" && item.assigned_to !== caller.name) return json({ ok: false, error: "forbidden" }, 403);
      if (item.type !== "Job Experience") return json({ ok: false, error: "not_a_job_experience_item" }, 400);

      let patch: EmployerCheckPatch;
      let kbStatus: string | null = null;
      const wr = item.source_item_id
        ? await fetch(`${SUPABASE_URL}/rest/v1/work_history_items?id=eq.${encodeURIComponent(item.source_item_id)}&select=company,employer_name_override,location,employer_location_override`, { headers: H })
        : null;
      const w = wr && wr.ok ? (await wr.json())[0] : null;
      const emp = w ? employerFromWorkHistory(w) : { name: null, state: null };
      if (!emp.name) patch = notCheckedPatch("no_employer_name");
      else if (!emp.state) patch = notCheckedPatch("no_state");
      else {
        try {
          const kb = await fetch(`${SUPABASE_URL}/functions/v1/kb-verify-business`, {
            method: "POST", headers: H, body: JSON.stringify({ name: emp.name, state: emp.state }), signal: AbortSignal.timeout(40_000),
          });
          const kj = await kb.json().catch(() => null);
          if (!kb.ok || !kj?.ok) patch = notCheckedPatch("kb_unavailable", `HTTP ${kb.status}`);
          else { patch = employerCheckFromKb(kj); kbStatus = kj.status; }
        } catch (e) { patch = notCheckedPatch("kb_unavailable", String((e as Error)?.message ?? e)); }
      }

      const up = await fetch(`${SUPABASE_URL}/rest/v1/verification_items?id=eq.${encodeURIComponent(itemId)}`, {
        method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
        body: JSON.stringify({
          employer_check: patch.employer_check, operating_status: patch.operating_status, operating_confirmation_required: patch.operating_confirmation_required,
          automated_check: mergeAutomatedCheck(item.automated_check, patch.automated_check_line),
        }),
      });
      if (!up.ok) return json({ ok: false, error: "item_update_failed", detail: (await up.text()).slice(0, 300) }, 502);
      return json({ ok: true, item_id: itemId, kb_status: kbStatus, employer_check_status: (patch.employer_check as { status: string }).status, operating_status: patch.operating_status, operating_confirmation_required: patch.operating_confirmation_required });
    } catch (e) {
      return json({ ok: false, error: "check_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  }),
};
