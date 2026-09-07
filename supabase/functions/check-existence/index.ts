// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

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
const { email, phone } = await req.json();
const hasEmail = typeof email === "string" && email.length > 0;
const hasPhone = typeof phone === "string" && phone.length > 0;
if (!hasEmail && !hasPhone) {
return new Response(JSON.stringify({ ok: false, error: "email or phone required" }), {
status: 400,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}

let exists = false;
const filters = [];
if (hasEmail) filters.push(`email.eq.${encodeURIComponent(email)}`);
if (hasPhone) filters.push(`phone.eq.${encodeURIComponent(phone)}`);
const orFilter = `or=(${filters.join(",")})`;

const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?select=discoverable&${orFilter}&limit=1`, {
headers: {
"apikey": SUPABASE_SERVICE_ROLE_KEY,
"Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
},
});

if (lookupRes.ok) {
const rows = await lookupRes.json();
exists = Array.isArray(rows) && rows.length > 0 && rows[0].discoverable === true;
}

return new Response(JSON.stringify({ exists }), {
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
} catch (e) {
return new Response(JSON.stringify({ exists: false }), {
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}
}),
};