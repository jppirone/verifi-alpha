// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// DELIBERATELY CONSTANT (2026-09-19). This used to answer {exists: true|false} for any email, which let anyone ask
// "does this address have a Verifi account?" as often as they liked (no rate limit, no proof of anything). That answer is
// no longer available to a caller who has not proved they own the address, so this endpoint no longer looks anything up:
// it answers {exists:false} for EVERY address, touches no table, and is therefore identical (status, body, content-type,
// timing) for a known and an unknown address. There is nothing here to rate limit because there is nothing to learn from it.
//
// It remains deployed only so a browser still holding an older candidate.html (pages are cached for a while) keeps
// working: {exists:false} sends it down the ordinary signup path, where the duplicate case is now resolved by the emailed
// link itself (send-verification / confirm-verification / check-verification-status): the person who OWNS the address is
// told, and signed in to the account they already have; nobody else is told anything. The current candidate.html no longer
// calls this at all.
export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      const { email, phone } = await req.json();
      if (!email || typeof email !== "string" || !phone || typeof phone !== "string") {
        return json({ ok: false, error: "Email and phone required" }, 400);
      }
      return json({ exists: false });
    } catch (_e) {
      return json({ ok: false, error: "Email and phone required" }, 400);
    }
  }),
};
