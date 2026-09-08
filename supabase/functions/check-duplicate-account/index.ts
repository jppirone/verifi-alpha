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
if (!email || typeof email !== "string" || !phone || typeof phone !== "string") {
return new Response(JSON.stringify({ ok: false, error: "Email and phone required" }), {
status: 400,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}

// Regression fix (2026-09-08, Item A): this used to join email/phone with `or=(...)`, so a
// candidate matching EITHER field alone reported exists:true even when the other field belonged
// to a different account entirely — reproduced live: a real email with a deliberately wrong
// phone, and a wrong email with a real phone, both returned exists:true before this fix. The
// validation above already guarantees both email and phone are present here, so (unlike
// check-existence, which also handles either field alone) this only ever needs the `and=(...)`
// composite form — both must match the SAME row.
const filter = `and=(email.eq.${encodeURIComponent(email)},phone.eq.${encodeURIComponent(phone)})`;
const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?select=id&${filter}&limit=1`, {
headers: {
"apikey": SUPABASE_SERVICE_ROLE_KEY,
"Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
},
});

if (!lookupRes.ok) {
const errText = await lookupRes.text();
return new Response(JSON.stringify({ ok: false, error: "Could not check for existing account", detail: errText }), {
status: 500,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}

const rows = await lookupRes.json();
return new Response(JSON.stringify({ exists: Array.isArray(rows) && rows.length > 0 }), {
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