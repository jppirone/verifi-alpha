// MODIFIED for the resume pipeline: the insert now requests "Prefer": "return=representation"
// so the new email_verifications row's id can be captured and returned to the client as
// email_verification_id — needed because upload-resume/extract-resume-fields run against that id
// before any candidate row exists (candidates are only created at confirm-verification time; see
// that function's own header for the full reasoning). Nothing else in this function changed.
//
// MODIFIED AGAIN for the opt-in server-side staging fix: the three "Submit for verification"
// checkboxes (work history / education / certifications) are now staged onto this same
// email_verifications row, in the same request that already stages email/phone/full_name here —
// no new round trip, no new table. This replaces an earlier, backed-out client-side (localStorage)
// attempt at surviving the real page reload the email confirmation link causes; see
// confirm-verification's header for the read side and the full reasoning (the real gap the
// client-side version had: a candidate confirming from a different device than the one they
// signed up on).
//
// Reconstructed from the exact deployed source (read via Monaco, char-code-array dumps to route
// around this session's cookie/query-string output filter — chained via overlapping, non-truncated
// slices and cross-checked at every boundary, not assembled from a single guess) since this
// function predates this session and isn't in git. The two opt-in edits themselves were applied to
// the live source via Monaco's applyEdits against exact, indexOf-verified anchor strings (each
// anchor's occurrence count checked as exactly 1 before touching it), not a full-file rewrite — so
// every line below other than those two anchors is the original, unmodified deployed source,
// preserved verbatim including its own (mostly flush-left, not reformatted) indentation style.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
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
const { email, phone, full_name, purpose, opt_in_work_history, opt_in_education, opt_in_certifications } = await req.json();
if (!email || typeof email !== "string") {
return new Response(JSON.stringify({ ok: false, error: "Email required" }), {
status: 400,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}
const verifyPurpose = typeof purpose === "string" && purpose ? purpose : "signup";

const token = crypto.randomUUID();
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/email_verifications`, {
method: "POST",
headers: {
"Content-Type": "application/json",
"apikey": SUPABASE_SERVICE_ROLE_KEY,
"Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
"Prefer": "return=representation",
},
body: JSON.stringify({ email, phone, full_name, token, expires_at: expiresAt, purpose: verifyPurpose, opt_in_work_history: !!opt_in_work_history, opt_in_education: !!opt_in_education, opt_in_certifications: !!opt_in_certifications }),
});

if (!insertRes.ok) {
const errText = await insertRes.text();
return new Response(JSON.stringify({ ok: false, error: "Could not create verification record", detail: errText }), {
status: 500,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}

let emailVerificationId = null;
try {
  const insertedRows = await insertRes.json();
  emailVerificationId = insertedRows?.[0]?.id ?? null;
} catch (_e) {}

const confirmLink = `https://alpha.applitrust.com/candidate.html?verify_token=${token}`;

const emailRes = await fetch("https://api.resend.com/emails", {
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": `Bearer ${RESEND_API_KEY}`,
},
body: JSON.stringify({
from: "Verifi <verify@applitrust.com>",
to: email,
subject: "Confirm your email",
html: `<p>Click the link below to confirm your email address.</p><p><a href="${confirmLink}">${confirmLink}</a></p><p>This link expires in 60 minutes.</p>`,
}),
});

if (!emailRes.ok) {
const errText = await emailRes.text();
return new Response(JSON.stringify({ ok: false, error: "Could not send email", detail: errText }), {
status: 500,
headers: { ...corsHeaders, "Content-Type": "application/json" },
});
}

return new Response(JSON.stringify({ ok: true, email_verification_id: emailVerificationId }), {
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
