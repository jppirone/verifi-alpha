// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real dead end this closes (2026-09-07 wiring audit, item 12): staff.html's "Assign to" dropdown
// was a hardcoded fake roster (WORKERS = ['Jordan Lee', 'Priya Nair', 'Sam Okafor']) despite the
// real staff_users table (see 20260906000000_staff_auth.sql) already existing and already backing
// real staff login. This is the one new read staff.html needed to stop using the fake roster.
//
// Returns every staff_users row, not just role='worker' — confirmed live before building this that
// the real roster today is a single admin account (no worker rows exist yet), so a worker-only
// filter would leave the dropdown with zero options. Assignment has never actually been role-gated
// (admins can already do everything workers can in this queue), so there's no real reason to exclude
// admins from being assignable too.
export default {
  fetch: withSupabase({ auth: "none" }, async (_req, _ctx) => {
    if (_req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?select=id,name,role&order=name.asc`, {
        headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      return new Response(JSON.stringify({
        ok: true,
        staff: rows.map((r: any) => ({ id: r.id, name: r.name, role: r.role })),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
