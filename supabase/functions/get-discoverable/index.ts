// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The read half of set-discoverable (2026-09-19). candidate.html never loaded candidates.discoverable
// from the server: its `discoverable` state always started at false, so any screen that showed the toggle
// after a page reload (in particular the signup plan screen, which a cancelled Stripe checkout lands back
// on) showed "unchecked" and its Continue button then saved that false over a real earlier choice.
// The client now asks the server for the real value before showing or saving it.
//
// Same identity model as set-discoverable and the rest of the candidate-side functions: by candidate_id,
// no session check. The two are meant to move to authenticated calls together in the pre-launch pass;
// what this exposes is one boolean about an account whose (unguessable) id the caller already holds.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const candidateId = body.candidate_id;
      if (!candidateId || typeof candidateId !== "string" || !/^[0-9a-f-]{36}$/i.test(candidateId)) {
        return json({ ok: false, error: "candidate_id_required" }, 400);
      }
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}&select=discoverable`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!res.ok) return json({ ok: false, error: "lookup_failed" }, 500);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return json({ ok: false, error: "candidate_not_found" }, 404);
      return json({ ok: true, discoverable: rows[0].discoverable === true });
    } catch (_e) {
      return json({ ok: false, error: "lookup_failed" }, 500);
    }
  }),
};
