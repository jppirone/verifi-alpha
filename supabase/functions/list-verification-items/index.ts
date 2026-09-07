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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,received,desired,follow_up,note,internal_note,automated_check,status,assigned_to,correction_requested,correction_note,correction_field,correction_value,source_item_id,verification_item_timeline(event_date,actor,action,note),candidates(id,full_name,first_name,last_name,email,phone)&order=id.asc&verification_item_timeline.order=event_date.asc";
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

      const [workHistoryContacts, certContacts] = await Promise.all([
        workHistoryIds.length
          ? fetch(`${SUPABASE_URL}/rest/v1/work_history_items?id=in.(${workHistoryIds.join(",")})&select=id,employer_name_override,employer_location_override,contact_phone,contact_name`, { headers: REST_HEADERS }).then((r) => r.ok ? r.json() : [])
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
