// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real dead end found live (2026-09-07 wiring audit): candidate.html's tiers/interstitial screen
// has called this function all along ({ email, phone, discoverable }), but it never existed —
// confirmed by direct HTTP probe, a genuine 404, not a bug in the client's request. Consequence,
// also confirmed live: candidates.discoverable defaults to false and this was the ONLY path that
// could ever set it true, so no candidate has ever been discoverable to an employer's existence
// check (check-existence, see that function's own header) since this build began.
//
// Written by candidate_id, not email/phone: every other write in this pipeline uses candidate_id
// once one exists (confirm-resume-data, skip-resume-extraction, etc.) — email/phone matching is
// this project's read-only existence/duplicate-check pattern (check-existence, check-duplicate-
// account), not how a specific candidate's own row gets written. resumeCandidateId is already
// reliably set by the time the tiers screen can even be reached (only reachable after
// applySignupConfirmation or a resolved session), so there's no real reason to accept the weaker,
// ambiguity-prone email/phone identity here — candidate.html's call site was updated to match.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, discoverable } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string" || typeof discoverable !== "boolean") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id and discoverable (boolean) are required" }), {
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
        body: JSON.stringify({ discoverable }),
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

      return new Response(JSON.stringify({ ok: true, discoverable: rows[0].discoverable }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
