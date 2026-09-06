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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { id, patch } = await req.json();
      if (!id || typeof id !== "string" || !patch || typeof patch !== "object") {
        return new Response(JSON.stringify({ ok: false, error: "id and patch are required" }), {
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

      const updateUrl = SUPABASE_URL + "/rest/v1/verification_items?id=eq." + encodeURIComponent(id);
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
