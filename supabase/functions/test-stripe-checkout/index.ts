// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// HIP-POCKET FEASIBILITY TEST — not wired into candidate.html or employer.html, no real
// product/tier decision made here, no live-mode keys anywhere. Proves the mechanism only: can this
// project create a real Stripe Checkout Session and actually take a test-mode payment through it.
//
// Deliberately calls Stripe's REST API directly with fetch() rather than pulling in Stripe's SDK —
// same lightweight pattern as every other integration built tonight, and Stripe's API is a plain
// form-encoded REST API with no SDK requirement. STRIPE_SECRET_KEY (sk_test_...) lives in this
// project's Edge Function secrets, same as every other credential here; test vs. live mode is
// determined entirely by which key is configured (sk_test_ vs sk_live_), not by a separate flag —
// there is currently no live-mode key configured anywhere in this project, checked before writing
// this.
//
// RESULT — DOCUMENTED SUCCESS. Confirmed against real, live Stripe Checkout Sessions (test mode,
// livemode:false in every response), not just "the API call returned 200":
//   - Success case: a session created here, completed in a real browser with Stripe's published
//     4242 4242 4242 4242 test card, redirected to success_url with a real session_id, and
//     produced a real checkout.session.completed webhook (paymentStatus "paid", amountTotal 1000,
//     currency "usd") — see test-stripe-webhook for the full verified payload.
//   - Decline case: a second session, same mechanism, completed with Stripe's published generic-
//     decline test card (4000 0000 0000 0002). The Checkout page correctly showed "Your credit
//     card was declined. Try paying with a debit card instead.", did not redirect, and — checked
//     explicitly, not assumed — produced zero webhook deliveries (a declined attempt never
//     reaches checkout.session.completed, since the session itself never completes).
// One thing worth flagging as slightly fragile, not a blocker: this hip-pocket test's own success/
// cancel URLs (verifi-test.example.com) don't resolve to real pages — fine for proving the
// mechanism, but a real integration needs real destination pages before this goes anywhere near
// candidate.html or employer.html.

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const body = new URLSearchParams();
      body.set("mode", "payment");
      body.set("success_url", "https://verifi-test.example.com/success?session_id={CHECKOUT_SESSION_ID}");
      body.set("cancel_url", "https://verifi-test.example.com/cancel");
      body.set("line_items[0][quantity]", "1");
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", "1000");
      body.set("line_items[0][price_data][product_data][name]", "Verifi test item (hip-pocket, not a real product)");

      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + STRIPE_SECRET_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: "stripe_error", status: res.status, detail: data }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        sessionId: data.id,
        url: data.url,
        mode: data.mode,
        livemode: data.livemode,
        amountTotal: data.amount_total,
        currency: data.currency,
      }), {
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
