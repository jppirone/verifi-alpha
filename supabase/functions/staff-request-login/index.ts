// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real staff login, step 1 of 2 — mirrors request-login's shape (real token, real Resend email,
// real expiry) against a parallel staff_login_tokens table, not candidates' login_tokens: that
// table's candidate_id carries a real NOT NULL foreign key to candidates(id), so a staff identity
// could never be inserted there without weakening a working, tested guarantee. See
// 20260906000000_staff_auth.sql for the full reasoning.
//
// No cross-device polling step exists for staff (compare candidate's check-login-status /
// issue_requester_session): an internal tool's users overwhelmingly click the link on the same
// device that requested it — a deliberate, confirmed scope reduction, not an oversight. Clicking
// the link (staff-confirm-login) is the only way this ever produces a session.
//
// Same posture on account enumeration as request-login: a real, honest "no account found" for an
// email with no staff_users row, not a generic "check your email" — this app already reveals
// account existence elsewhere, and staff_users has no self-service signup to protect in the first
// place (rows are added directly via SQL, by design — see the migration).
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

      if (!email || typeof email !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "email_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const staffRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=id`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!staffRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const staffRows = await staffRes.json();
      const staffUser = staffRows[0];
      if (!staffUser) {
        return new Response(JSON.stringify({ ok: false, error: "no_account_found", message: "We couldn't find a staff account for that email." }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_login_tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ email, token, staff_user_id: staffUser.id, expires_at: expiresAt }),
      });
      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return new Response(JSON.stringify({ ok: false, error: "could_not_create_login_token", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const loginLink = `https://alpha.applitrust.com/staff.html?login_token=${token}`;

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "Verifi <verify@applitrust.com>",
          to: email,
          subject: "Your Verifi staff login link",
          html: `<p>Click the link below to log in to the staff queue.</p><p><a href="${loginLink}">${loginLink}</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
        }),
      });
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        return new Response(JSON.stringify({ ok: false, error: "could_not_send_email", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
