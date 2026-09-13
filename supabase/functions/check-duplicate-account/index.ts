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
// phone, and a wrong email with a real phone, both returned exists:true before this fix.
//
// MODIFIED AGAIN (2026-09-13, real gap found during the session-precedence investigation): the
// and=(...) composite form that Item A landed on required BOTH email and phone to match the SAME
// row, which quietly reopened a different hole — signing up again with a previously-used email but
// a different phone (or one typo'd differently) went completely undetected, even though a real
// candidates row for that email already existed. Confirmed directly against this table's own live
// schema before changing this: `candidates_email_key` is a real, enforced UNIQUE(email) constraint
// (candidates.phone has no uniqueness constraint at all, and never has) — email is already this
// system's one and only identity key at the database level; confirm-verification's own
// isDuplicateEmail/23505 handling exists specifically because that constraint is real. Matching on
// email ALONE here doesn't introduce a new assumption, it just makes this pre-signup check agree
// with a rule the database has already been enforcing unconditionally on every insert. phone is
// deliberately NOT part of the match (that's what Item A's own fix already established, for a real,
// reproduced reason: phone is not unique, so OR-ing it back in — or requiring it via AND, which
// silently degrades to the same under-detection this fixes — reopens exactly the false-positive
// and false-negative failure modes Item A and this fix each closed). Still required as an input
// above — phone stays a genuine signup field the client always collects and sends, just no longer
// part of what makes a candidate a duplicate.
// PostgREST syntax note (real bug, caught live testing this exact change): the dotted
// `column.eq.value` form is only valid INSIDE an and=(...)/or=(...) combinator — the form the old
// code needed for its two-condition and=(...) filter. A bare top-level filter (one condition, no
// combinator) needs the column as the query-param NAME instead: `column=eq.value`. Keeping the
// dotted form here after dropping the and=(...) wrapper produced a real, malformed param that
// PostgREST silently ignores — degrading this into an unfiltered `select=id&limit=1`, i.e. "return
// any one candidate row, regardless of email" — confirmed live: a genuinely unused email
// incorrectly came back exists:true before this correction.
const filter = `email=eq.${encodeURIComponent(email)}`;
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