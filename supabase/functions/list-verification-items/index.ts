// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,received,desired,follow_up,note,internal_note,automated_check,status,assigned_to,correction_requested,correction_note,correction_field,correction_value,verification_item_timeline(event_date,actor,action,note),candidates(id,full_name,first_name,last_name,email,phone)&order=id.asc&verification_item_timeline.order=event_date.asc";
      const res = await fetch(url, {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      const items = rows.map((r) => ({
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
        timeline: (r.verification_item_timeline || []).map((t) => ({
          date: t.event_date,
          actor: t.actor,
          action: t.action,
          note: t.note,
        })),
      }));
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
