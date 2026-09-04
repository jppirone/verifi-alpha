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
// design). If no candidate exists, this returns a real, honest error rather than a generic
// "check your email" — this codebase already reveals account existence during signup itself (the
// duplicate-email check candidate.html runs before every signup attempt), so hiding it here would
// be a new, inconsistent posture, not a real security improvement; deliberately not adding email-
// enumeration protection that doesn't exist anywhere else in this app.
//
// 15-minute expiry (vs. signup's 60 minutes): a login link is meant to be used within the same
// sitting it was requested in, and a materially shorter window reduces the real exposure if the
// email itself is compromised — standard practice for login links specifically, not carried over
// from signup by default.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const body = await req.json();
      const email = body.email;
      const channel = typeof body.channel === "string" && body.channel ? body.channel : "email";

      if (!email || typeof email !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "email_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?email=eq.${encodeURIComponent(email)}&select=id`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!candRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const candRows = await candRes.json();
      const candidate = candRows[0];
      if (!candidate) {
        return new Response(JSON.stringify({ ok: false, error: "no_account_found", message: "We couldn't find an account for that email." }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/login_tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ email, channel, token, candidate_id: candidate.id, expires_at: expiresAt }),
      });
      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return new Response(JSON.stringify({ ok: false, error: "could_not_create_login_token", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const insertedRows = await insertRes.json();
      const loginTokenId = insertedRows?.[0]?.id ?? null;

      const loginLink = `https://alpha.applitrust.com/candidate.html?login_token=${token}`;

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "Verifi <verify@applitrust.com>",
          to: email,
          subject: "Your Verifi login link",
          html: `<p>Click the link below to log in.</p><p><a href="${loginLink}">${loginLink}</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
        }),
      });
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        return new Response(JSON.stringify({ ok: false, error: "could_not_send_email", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, login_token_id: loginTokenId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
