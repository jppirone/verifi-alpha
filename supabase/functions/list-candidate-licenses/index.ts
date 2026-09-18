// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 11 (2026-09-13 live-testing session): the License Status tab's real data source for
// license_only accounts. Deliberately NOT get-resume-extraction — that function is keyed entirely
// off a resume_documents row (see its own RESUME_DOC_SELECT/effectiveDoc logic), and a license_only
// candidate structurally never has one; calling it would just return resume_document: null and no
// certifications key at all. This reads certification_items directly by candidate_id instead, the
// same table Item 8's license_number/trade_soc_code fields already live on — a license-only
// candidate's row there always has resume_document_id: null (see confirm-verification's own header),
// so ordering by created_at (not position, which only ever means something relative to a resume's
// own layout) is the right default here.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/certification_items?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id,name,issuing_body,license_number,trade_soc_code,issue_date,expiration_date,status,candidate_confirmed,created_at&order=created_at.asc`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const licenses = await res.json();

      // Automatic license verification: a license is this certification row plus its 1:1 license_items
      // extension (see confirm-verification). Joined here so the License Status tab can show a real
      // outcome, and offer the edit / self-correction surface, instead of the never-written
      // certification_items.status.
      const restHeaders = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
      const liRes = await fetch(
        `${SUPABASE_URL}/rest/v1/license_items?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id,linked_certification_id,state,verification_outcome,queue_item_id,correction_status,correction_reason,correction_message`,
        { headers: restHeaders },
      );
      const liRows: any[] = liRes.ok ? await liRes.json() : [];
      const queueIds = liRows.map((l) => l.queue_item_id).filter(Boolean);
      const queueRows: any[] = queueIds.length
        ? await fetch(`${SUPABASE_URL}/rest/v1/verification_items?id=in.(${queueIds.map(encodeURIComponent).join(",")})&select=id,status`, { headers: restHeaders }).then((r) => r.ok ? r.json() : [])
        : [];
      const queueStatusById = new Map(queueRows.map((q) => [q.id, q.status]));
      const verificationByCert = new Map(liRows.map((l) => {
        const qStatus = l.queue_item_id ? queueStatusById.get(l.queue_item_id) : null;
        return [l.linked_certification_id, {
          license_item_id: l.id,
          state: l.state || null, outcome: l.verification_outcome || null,
          verified: qStatus === "Confirmed",
          editable: l.verification_outcome !== "verified" && qStatus !== "Confirmed" && qStatus !== "Discrepancy",
          correction: l.correction_status === "requested"
            ? { status: "requested", reason: l.correction_reason || null, message: l.correction_message || null }
            : null,
        }];
      }));
      for (const lic of licenses) lic.verification = verificationByCert.get(lic.id) || null;

      return new Response(JSON.stringify({ ok: true, licenses }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
