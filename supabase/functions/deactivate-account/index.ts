// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real dead end this closes (2026-09-07 wiring audit, item 5): candidate.html's confirmDeactivate()
// was 100% local React state — clicking "deactivate" never told the server anything, so the
// account stayed fully logged in, fully accessible, on every device, indefinitely. This function
// is the real backend: it sets candidates.deletion_scheduled_at (see this migration's own header,
// 20260907020000_account_deactivation.sql, for why that's a "when," not the purge date itself) and
// revokes EVERY session this candidate holds, not just the calling device's — deliberately broader
// than logout's single-token_hash revoke, because deactivation has to end access everywhere at
// once, the same moment, not just on the device that clicked the button.
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

      const now = new Date();

      const candRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ deletion_scheduled_at: now.toISOString() }),
      });
      if (!candRes.ok) {
        const detail = await candRes.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const candRows = await candRes.json();
      if (!Array.isArray(candRows) || candRows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Revoke by candidate_id, every still-active session — deliberately broader than logout's
      // single-token_hash PATCH (see logout's own header). "Still active" (revoked_at is null)
      // rather than an unconditional PATCH of all rows so an already-revoked/expired session's
      // revoked_at timestamp isn't overwritten with a later, misleading one.
      const sessRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_sessions?candidate_id=eq.${encodeURIComponent(candidate_id)}&revoked_at=is.null`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ revoked_at: now.toISOString() }),
        },
      );
      if (!sessRes.ok) {
        const detail = await sessRes.text();
        return new Response(JSON.stringify({ ok: false, error: "session_revoke_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const deletionDate = new Date(now);
      deletionDate.setDate(deletionDate.getDate() + 30);

      return new Response(JSON.stringify({
        ok: true,
        deletion_scheduled_at: now.toISOString(),
        deletion_date: deletionDate.toISOString().slice(0, 10),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
