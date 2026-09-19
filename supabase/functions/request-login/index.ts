// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Passwordless login, step 1 of 3 — mirrors send-verification's shape closely (real token,
// real Resend email, real expiry), staged onto its own login_tokens table rather than reusing
// email_verifications (see that migration's header for why).
//
// Unlike signup's send-verification, this does NOT stage a candidate — a candidate for this email
// must already exist (created only at confirm-verification time, per this project's own hygiene
// design).
//
// NO EXISTENCE ORACLE (2026-09-19). This used to answer 404 "no account found" for an address with no candidate, with no
// rate limit — and its old header argued that was consistent with the duplicate-email check signup ran, which was itself an
// oracle. Both are gone. From the caller's side this now behaves exactly like employer-request-login / staff-request-login:
//   * The response never depends on whether the address has an account: always {ok:true, login_token_id, link_minutes} once the
//     request is accepted. login_token_id is the id of the attempt row below for EVERY address.
//   * The work that does depend on it — looking the candidate up, creating the login_tokens row (with that SAME id) and sending
//     the email, all of which only a real account gets — runs AFTER the response is returned, as an Edge Runtime background
//     task, so the response TIME does not depend on it either. Everything the caller can observe (the two limit lookups and the
//     attempt insert) is the same work for a known and an unknown address. check-login-status answers "pending" from the attempt
//     row when no login_tokens row exists, so polling cannot tell the two apart either.
//   * Abuse limits: at most 5 requests per address per hour across login AND signup (429), and a global ceiling per hour (429),
//     counted from candidate_login_attempts, which records EVERY request (login_tokens only holds real candidates, so counting
//     it would make the limit itself an oracle). Only input SHAPE is ever rejected with a 400.
// Consequence: a real candidate whose email fails to send is no longer told in the response (it is logged here); they request
// another link. An unknown address simply never receives anything.
//
// 15-minute expiry (vs. signup's 60 minutes): a login link is meant to be used within the same
// sitting it was requested in, and a materially shorter window reduces the real exposure if the
// email itself is compromised — standard practice for login links specifically, not carried over
// from signup by default.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const LINK_MINUTES = 15;
const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 500;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function sendLoginLinkIfCandidate(typedEmail: string, email: string, channel: string, attemptId: string): Promise<void> {
  try {
    // Exact match on what was typed first (candidates.email is a case-sensitive unique key, as before), then on the lowercased form.
    let candidate: { id: string; email: string } | undefined;
    for (const e of [...new Set([typedEmail, email])]) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/candidates?email=eq.${encodeURIComponent(e)}&select=id,email`, { headers: REST });
      if (!r.ok) { console.error("request-login: candidate lookup failed", r.status); return; }
      candidate = (await r.json())[0];
      if (candidate) break;
    }
    if (!candidate) return; // no account: nothing is created or sent, and nothing about that is observable to the caller

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/login_tokens`, {
      method: "POST",
      headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ id: attemptId, email: candidate.email, channel, token, candidate_id: candidate.id, expires_at: expiresAt }),
    });
    if (!insertRes.ok) { console.error("request-login: could not create login token", insertRes.status, await insertRes.text()); return; }

    const loginLink = `https://alpha.applitrust.com/candidate.html?login_token=${token}`;
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Verifi <verify@applitrust.com>",
        to: candidate.email,
        subject: "Your Verifi login link",
        html: `<p>Click the link below to log in.</p><p><a href="${loginLink}">${loginLink}</a></p><p>This link expires in ${LINK_MINUTES} minutes and can only be used once. If you didn't ask for it, ignore this email.</p>`,
      }),
    });
    if (!emailRes.ok) {
      console.error("request-login: could not send email", emailRes.status, await emailRes.text());
      // Nothing was delivered, so the token is unreachable: remove it.
      try { await fetch(`${SUPABASE_URL}/rest/v1/login_tokens?id=eq.${attemptId}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ }
    }
  } catch (e) {
    console.error("request-login: background send failed -", String(e));
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
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const typedEmail = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
      const email = typedEmail.toLowerCase();
      const channel = typeof body.channel === "string" && body.channel ? body.channel.slice(0, 20) : "email";
      if (!typedEmail) return json({ ok: false, error: "email_required" }, 400);
      if (!/^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/.test(email)) return json({ ok: false, error: "email_invalid" }, 400);

      // Limits, counted over EVERY request for the address (known or not), login and signup alike.
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [perEmailRes, globalRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?email=eq.${encodeURIComponent(email)}&requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_EMAIL_PER_HOUR + 1}`, { headers: REST }),
        fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${GLOBAL_PER_HOUR + 1}`, { headers: REST }),
      ]);
      if (!perEmailRes.ok || !globalRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const perEmail = await perEmailRes.json();
      const global = await globalRes.json();
      if (Array.isArray(perEmail) && perEmail.length >= PER_EMAIL_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);
      if (Array.isArray(global) && global.length >= GLOBAL_PER_HOUR) return json({ ok: false, error: "busy" }, 429);

      const attemptRes = await fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts`, {
        method: "POST",
        headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({ email, kind: "login" }),
      });
      if (!attemptRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const attemptId = (await attemptRes.json())?.[0]?.id;
      if (!attemptId) return json({ ok: false, error: "request_failed" }, 500);

      // Housekeeping + the part that depends on the account, both after the response.
      const work = (async () => {
        try { await fetch(`${SUPABASE_URL}/rest/v1/candidate_login_attempts?requested_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ }
        await sendLoginLinkIfCandidate(typedEmail, email, channel, attemptId);
      })();
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") edgeRuntime.waitUntil(work);
      else await work;

      return json({ ok: true, login_token_id: attemptId, link_minutes: LINK_MINUTES });
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
