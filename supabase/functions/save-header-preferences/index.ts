// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 6 (2026-09-12 live-testing session, follow-up build): the one real backend write path for
// candidate.html's new Personal Info "Document header on generated files" choice.
//
// Deliberately narrow, not a general profile-save endpoint: every OTHER Profile Info field today
// (first/last name, printed phone/email, notification prefs) is client-state-only and never
// actually persisted (saveActive() for the profile tab just copies React state — confirmed live,
// no backend call anywhere). That's a real, separate gap, out of scope here. header_display_mode
// and personal_location specifically need to survive a refresh or a new session, because they
// govern what a real generated document or partner delivery actually contains — losing them
// silently would defeat the point of the choice. Modeled on set-candidate-tier's own shape (a
// single-purpose PATCH, not a generic profile-update function) rather than folding this into a
// broader save endpoint that doesn't exist yet.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, header_display_mode, personal_location } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (header_display_mode !== "printed" && header_display_mode !== "account") {
        return new Response(JSON.stringify({ ok: false, error: "header_display_mode_must_be_printed_or_account" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          header_display_mode,
          personal_location: (typeof personal_location === "string" && personal_location.trim()) || null,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        header_display_mode: rows[0].header_display_mode,
        personal_location: rows[0].personal_location,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
