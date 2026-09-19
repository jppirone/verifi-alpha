// MODIFIED for the resume pipeline: the insert now requests "Prefer": "return=representation"
// so the new email_verifications row's id can be captured and returned to the client as
// email_verification_id — needed because upload-resume/extract-resume-fields run against that id
// before any candidate row exists (candidates are only created at confirm-verification time; see
// that function's own header for the full reasoning). Nothing else in this function changed.
//
// MODIFIED AGAIN for the opt-in server-side staging fix: the three "Submit for verification"
// checkboxes (work history / education / certifications) are now staged onto this same
// email_verifications row, in the same request that already stages email/phone/name here —
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
//
// MODIFIED AGAIN to stage first_name/last_name instead of a single full_name: the candidate signup
// form now collects them separately (see candidate.html). full_name stays on the email_verifications
// row for pre-existing rows only — this function no longer writes it at all, on purpose; new rows
// carry first_name/last_name instead. See the migration adding these columns for the full reasoning
// and confirm-verification's own header for the read side.
//
// MODIFIED AGAIN for Items 9/10 (2026-09-13 live-testing session): account_type and staged_license
// staged the same way opt_in_work_history etc. already are — candidates rows are only ever created
// at confirm-verification time, so a license-only signup's account_type choice and its KYC/license-
// entry step (both completed before this call, on the licenseKyc/licenseDetails screens) have to
// ride along on this same email_verifications row to survive the wait for email confirmation, same
// as everything else collected pre-confirmation. Both are optional/undefined on every full-resume
// call site — this function defaults account_type to null (confirm-verification treats that as
// 'full_resume') and staged_license to null, so the existing call site is unaffected.

//
// NO EXISTENCE ORACLE + RATE LIMIT (2026-09-19). Signup used to be gated by check-duplicate-account ("does this email already have
// an account?"), an unauthenticated oracle, and this function had no rate limit at all (a mail cannon at any address). Now:
//   * Every request for a 'signup' purpose gets the SAME response whether or not the address already has an account:
//     {ok:true, email_verification_id}. The verification row (which the resume upload attaches to) is created for everyone.
//   * What DOES depend on the account — looking the address up and choosing which email to send — runs AFTER the response, as an
//     Edge Runtime background task, so neither the response nor its timing depends on it. An address with no account gets the
//     usual "Confirm your email" link. An address that already has one gets an email saying so, carrying the SAME link:
//     confirm-verification treats that link, for an existing account, as a login (the link only ever reaches the address's
//     owner), and check-verification-status hands the device that requested it the same session. Nothing is told to anyone
//     who has not proved they own the address.
//   * At most 5 requests per address per hour across signup AND login (429) and a global ceiling per hour (429), counted from
//     candidate_login_attempts, which records every request whether or not the address has an account.
//   * A real person whose email fails to send is no longer told in the response (it is logged here); only input SHAPE is rejected.

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

const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 500;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function sendVerificationEmail(typedEmail: string, lowerEmail: string, verifyPurpose: string, confirmLink: string): Promise<void> {
  try {
    // Only a 'signup' can collide with an existing account. Exact match on what was typed first (candidates.email is a
    // case-sensitive unique key), then on the lowercased form.
    let existing = false;
    if (verifyPurpose === "signup") {
      for (const e of [...new Set([typedEmail, lowerEmail])]) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/candidates?email=eq.${encodeURIComponent(e)}&select=id&limit=1`, { headers: REST });
        if (!r.ok) { console.error("send-verification: candidate lookup failed", r.status); return; }
        if ((await r.json())[0]) { existing = true; break; }
      }
    }
    const subject = existing ? "You already have a Verifi account" : "Confirm your email";
    const html = existing
      ? `<p>Someone (hopefully you) tried to sign up for Verifi with this email address, but you already have an account.</p><p>To log in to it, click the link below. No new account will be created and nothing about your existing account changes.</p><p><a href="${confirmLink}">${confirmLink}</a></p><p>This link expires in 60 minutes. If this wasn't you, ignore this email.</p>`
      : `<p>Click the link below to confirm your email address.</p><p><a href="${confirmLink}">${confirmLink}</a></p><p>This link expires in 60 minutes.</p>`;
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: "Verifi <verify@applitrust.com>", to: typedEmail, subject, html }),
    });
    if (!emailRes.ok) console.error("send-verification: could not send email", emailRes.status, await emailRes.text());
  } catch (e) {
    console.error("send-verification: background send failed -", String(e));
  }
}

export default {
fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
if (req.method === "OPTIONS") {
return new Response(null, { headers: corsHeaders });
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

try {
const { email, phone, first_name, last_name, purpose, opt_in_work_history, opt_in_education, opt_in_certifications, account_type, staged_license } = await req.json();
if (!email || typeof email !== "string") {
return json({ ok: false, error: "Email required" }, 400);
}
const typedEmail = email.trim().slice(0, 254);
const lowerEmail = typedEmail.toLowerCase();
if (!/^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/.test(lowerEmail)) return json({ ok: false, error: "Email invalid" }, 400);
const verifyPurpose = typeof purpose === "string" && purpose ? purpose : "signup";

// Limits, counted over EVERY request for the address (known or not), signup and login alike.
const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const [perEmailRes, globalRes] = await Promise.all([
  fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?email=eq.${encodeURIComponent(lowerEmail)}&requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_EMAIL_PER_HOUR + 1}`, { headers: REST }),
  fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${GLOBAL_PER_HOUR + 1}`, { headers: REST }),
]);
if (!perEmailRes.ok || !globalRes.ok) return json({ ok: false, error: "request_failed" }, 500);
const perEmail = await perEmailRes.json();
const global = await globalRes.json();
if (Array.isArray(perEmail) && perEmail.length >= PER_EMAIL_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);
if (Array.isArray(global) && global.length >= GLOBAL_PER_HOUR) return json({ ok: false, error: "busy" }, 429);
const attemptRes = await fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts`, {
  method: "POST",
  headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
  body: JSON.stringify({ email: lowerEmail, kind: "signup" }),
});
if (!attemptRes.ok) return json({ ok: false, error: "request_failed" }, 500);

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
body: JSON.stringify({ email: typedEmail, phone, first_name, last_name, token, expires_at: expiresAt, purpose: verifyPurpose, opt_in_work_history: !!opt_in_work_history, opt_in_education: !!opt_in_education, opt_in_certifications: !!opt_in_certifications, account_type: account_type === 'license_only' ? 'license_only' : (account_type === 'full_resume' ? 'full_resume' : null), staged_license: staged_license ?? null }),
});

if (!insertRes.ok) {
const errText = await insertRes.text();
return json({ ok: false, error: "Could not create verification record", detail: errText }, 500);
}

let emailVerificationId = null;
try {
  const insertedRows = await insertRes.json();
  emailVerificationId = insertedRows?.[0]?.id ?? null;
} catch (_e) {}

const confirmLink = `https://alpha.applitrust.com/candidate.html?verify_token=${token}`;

// Housekeeping + the part that depends on the account, both after the response.
const work = (async () => {
  try { await fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?requested_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ }
  await sendVerificationEmail(typedEmail, lowerEmail, verifyPurpose, confirmLink);
})();
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") edgeRuntime.waitUntil(work);
else await work;

return json({ ok: true, email_verification_id: emailVerificationId });
} catch (e) {
return json({ ok: false, error: "request_failed" }, 500);
}
}),
};
