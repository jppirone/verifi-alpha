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
// Regression fix (2026-09-08): this used to join email/phone with `or=(...)`, so a candidate
// matching EITHER field alone reported exists:true even when the other field belonged to a
// different account entirely (or no account at all) — reproduced live: a real email with a
// deliberately wrong phone, and a wrong email with a real phone, both returned exists:true before
// this fix. When both email and phone are supplied they must match the SAME row (`and`); either
// one alone is still a valid, complete check when the other wasn't provided.
// `and=(col.eq.val,...)` composite syntax when both are given (dot-separated column/operator
// inside the wrapper); a bare top-level filter uses `column=eq.value` instead (equals-separated)
// when only one field was provided — these are NOT interchangeable in PostgREST's query syntax.
let combinedFilter: string;
if (hasEmail && hasPhone) {
combinedFilter = `and=(email.eq.${encodeURIComponent(email)},phone.eq.${encodeURIComponent(phone)})`;
} else if (hasEmail) {
combinedFilter = `email=eq.${encodeURIComponent(email)}`;
} else {
combinedFilter = `phone=eq.${encodeURIComponent(phone)}`;
}

const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?select=discoverable&${combinedFilter}&limit=1`, {
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