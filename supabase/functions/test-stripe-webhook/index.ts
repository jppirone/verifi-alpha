// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, stripe-signature",
};

// 2026-09-19 (employer billing): this is still the ONE endpoint Stripe delivers to, so it is now also the router. After
// signature verification it (1) rejects a stale signed timestamp, (2) works out whether the event is an employer event
// (metadata.product "employer_*" or an id that belongs to an employer row), (3) claims the event id so a re-delivery is
// acknowledged without being processed again, and (4) forwards employer events to employer-stripe-events. Candidate
// events then run exactly the logic below, except that an explicit unrecognized product is no longer defaulted into
// resume_pro. customer.subscription.updated is still not handled for candidates.
//
// Item B (2026-09-08 regression session): this function's signature-verification core is the
// original HIP-POCKET FEASIBILITY TEST, proven working against a real Stripe webhook delivery (see
// the RESULT block below, unchanged) — reused as-is, not rebuilt. What's new: on a real
// checkout.session.completed with payment_status "paid", this now actually writes
// candidates.tier = 'paid' (see test-stripe-checkout's own header for client_reference_id, the
// mechanism that ties a session back to a real candidate_id) instead of only verifying and echoing
// the event. Previously this function proved Stripe delivery works but touched the database not at
// all — a real webhook could arrive all day and nothing downstream would ever know.
//
// Original header, still accurate for the signature-verification mechanism itself:
//
// HIP-POCKET FEASIBILITY TEST — companion to test-stripe-checkout. Proves the other half of the
// mechanism: does this project actually learn a payment succeeded (not just that a checkout page
// loaded)? Real Stripe webhook signature verification, implemented directly against the documented
// algorithm (Web Crypto HMAC-SHA256) rather than pulling in the Stripe SDK, same lightweight
// pattern as everything else tonight:
//   Stripe-Signature header shape: "t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]"
//   signed payload = "<timestamp>.<raw request body>" (the EXACT raw bytes, not re-serialized
//   JSON — this must be read via req.text() before any JSON.parse, or the signature will never
//   match even with a correct secret)
//   expected v1 = hex(HMAC-SHA256(STRIPE_WEBHOOK_SECRET, signed payload))
// STRIPE_WEBHOOK_SECRET (whsec_...) comes from registering this deployed function's URL as a
// webhook endpoint in the Stripe Dashboard (test mode) — Stripe generates that secret per
// endpoint, it isn't chosen or predictable in advance.
//
// No live-mode key or endpoint anywhere in this project — checked before any of this was built.
//
// RESULT — DOCUMENTED SUCCESS. Confirmed with a real event, not a synthetic "send test event":
// completing a real Checkout Session in a browser with Stripe's 4242 4242 4242 4242 test card
// produced a genuine checkout.session.completed webhook call from Stripe's own servers
// (User-Agent: "Stripe/1.0", source IP owned by Amazon/Stripe infra), which this function verified
// and parsed correctly. The exact response body Stripe recorded for that delivery (visible in its
// own dashboard, Delivered, HTTP 200):
//   {"ok":true,"verified":true,"signatureTimestamp":"1788441531",
//    "eventId":"evt_1UBaXXRqPebINCzH0eLhc1Lc","eventType":"checkout.session.completed",
//    "livemode":false,"checkoutSession":{"id":"cs_test_a1a4PP...","paymentStatus":"paid",
//    "amountTotal":1000,"currency":"usd","customerEmail":"test@verifi-test.example.com"}}
// Every field matches the real checkout exactly (amount, currency, the email typed into the
// Checkout form). Separately confirmed the negative case: completing a second session with
// Stripe's decline test card (4000 0000 0000 0002) produced a real "Your credit card was
// declined" error on the Checkout page and — checked via this function's own invocation log, not
// assumed — zero webhook deliveries, since a session that never completes never fires this event.
//
// One real setup gotcha worth flagging, not a code problem: Supabase's own "Verify JWT with legacy
// secret" project-level setting is ON by default for a new function and sits in front of this
// function's own code — a Stripe webhook call carries no Supabase auth header at all, so with that
// setting on, Stripe's requests were rejected before ever reaching the signature-verification code
// below. Had to be turned off explicitly in this function's Settings tab (labeled "Recommended:
// OFF with JWT and custom auth logic in your function code" — which is exactly this function's
// situation). Easy to miss the first time; the failure mode if missed would be a 401 with no
// application-level error message explaining why.

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<{ valid: boolean; timestamp?: string }> {
  const parts: Record<string, string[]> = {};
  for (const piece of sigHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const k = piece.slice(0, eq);
    const v = piece.slice(eq + 1);
    (parts[k] ||= []).push(v);
  }
  const t = parts["t"]?.[0];
  const v1s = parts["v1"] || [];
  if (!t || v1s.length === 0) return { valid: false };

  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computedHex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { valid: v1s.includes(computedHex), timestamp: t };
}

const WEBHOOK_TOLERANCE_SECONDS = 300;
const SB_HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

// Is this event an employer-billing event? Two independent signals, either one is enough:
//   1. the object carries metadata.product starting with "employer_" (set on every employer session / subscription /
//      payment intent at creation), or
//   2. a Stripe id on the object (customer, subscription, payment intent) belongs to an employer row. This catches
//      events whose object does not carry our metadata (charges, invoices, etc.).
// A database error propagates: the caller must not fall through to candidate logic when it cannot tell.
async function isEmployerEvent(event: any): Promise<boolean> {
  const obj = event?.data?.object || {};
  const product = obj?.metadata?.product;
  if (typeof product === "string" && product.startsWith("employer_")) return true;
  const str = (v: any) => (typeof v === "string" ? v : (v && typeof v.id === "string" ? v.id : null));
  const customer = str(obj.customer);
  const subscription = obj.object === "subscription" ? str(obj.id) : str(obj.subscription);
  const paymentIntent = obj.object === "payment_intent" ? str(obj.id) : str(obj.payment_intent);
  if (!customer && !subscription && !paymentIntent) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/employer_owns_stripe_ids`, {
    method: "POST", headers: SB_HEADERS, body: JSON.stringify({ p_customer: customer, p_subscription: subscription, p_payment_intent: paymentIntent }),
  });
  if (!res.ok) throw new Error(`employer_owns_stripe_ids ${res.status}`);
  return (await res.json()) === true;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (!STRIPE_WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: "STRIPE_WEBHOOK_SECRET not configured yet" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sigHeader = req.headers.get("stripe-signature");
    const rawBody = await req.text(); // raw, unparsed — required for signature verification
    if (!sigHeader) {
      return new Response(JSON.stringify({ ok: false, error: "missing_stripe_signature_header" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { valid, timestamp } = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return new Response(JSON.stringify({ ok: false, error: "signature_verification_failed" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Replay protection, part 1 (2026-09-19): the signature only proves the payload came from Stripe, not that it is
    // fresh. Reject a signed payload whose timestamp is more than 5 minutes off (Stripe's own default tolerance), so a
    // captured request cannot be replayed later. (Stripe signs each delivery attempt with a fresh timestamp, so
    // legitimate retries are unaffected.)
    const tsNum = Number(timestamp);
    if (!isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > WEBHOOK_TOLERANCE_SECONDS) {
      return new Response(JSON.stringify({ ok: false, error: "signature_timestamp_out_of_tolerance" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json_body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const summary: Record<string, unknown> = {
      ok: true,
      verified: true,
      signatureTimestamp: timestamp,
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
    };

    // ---- Routing + replay protection part 2 (2026-09-19) — runs BEFORE any candidate logic below ----
    // One Stripe endpoint receives every event on the account, candidate and employer alike. Decide whose it is first,
    // claim the event id (a re-delivered event is acknowledged and NOT processed again), and hand employer events to
    // their own handler. Nothing below this block ever sees an employer event.
    let kind: "employer" | "candidate";
    try {
      kind = (await isEmployerEvent(event)) ? "employer" : "candidate";
    } catch (e) {
      // Cannot tell whose event this is: fail so Stripe retries, rather than guess into candidate logic.
      return new Response(JSON.stringify({ ok: false, error: "routing_failed", detail: String(e).slice(0, 200) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    summary.routedTo = kind;
    let claimed = false;
    try {
      const claimRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_stripe_event`, {
        method: "POST", headers: SB_HEADERS, body: JSON.stringify({ p_event_id: event.id, p_type: event.type, p_kind: kind }),
      });
      if (!claimRes.ok) throw new Error(`claim ${claimRes.status}`);
      claimed = (await claimRes.json()) === true;
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "idempotency_check_failed", detail: String(e).slice(0, 200) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!claimed) {
      return new Response(JSON.stringify({ ok: true, duplicate: true, eventId: event.id, routedTo: kind }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const rpcDone = (fn: "finish_stripe_event" | "release_stripe_event", outcome: string) =>
      fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify({ p_event_id: event.id, p_outcome: outcome }) }).catch(() => {});
    if (kind === "employer") {
      try {
        const fwd = await fetch(`${SUPABASE_URL}/functions/v1/employer-stripe-events`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ event }),
        });
        const out = await fwd.json().catch(() => ({}));
        if (!fwd.ok || !out.ok) throw new Error(`employer handler ${fwd.status} ${out.detail || out.error || ""}`);
        await rpcDone("finish_stripe_event", "employer:" + out.outcome);
        return new Response(JSON.stringify({ ...summary, employerOutcome: out.outcome }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        // Unlike the candidate branch (which never fails a verified delivery), an employer payment must not be lost:
        // release the claim and return non-2xx so Stripe retries.
        await rpcDone("release_stripe_event", "employer_failed:" + String(e).slice(0, 120));
        return new Response(JSON.stringify({ ok: false, error: "employer_handler_failed", detail: String(e).slice(0, 200) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      summary.checkoutSession = {
        id: session.id,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        currency: session.currency,
        customerEmail: session.customer_details?.email ?? null,
      };

      // Item B: the real write this event used to skip entirely. client_reference_id is set to
      // candidate_id by test-stripe-checkout for exactly this purpose — Stripe's own documented
      // mechanism for attributing a session back to an internal id without a second lookup.
      // payment_status === "paid" (not just "the session completed") is the real gate: a completed
      // subscription Checkout session is only ever "paid" once payment has actually gone through.
      //
      // Item 10 (2026-09-13 live-testing session): session.metadata.product (set by test-stripe-
      // checkout) is now checked BEFORE deciding which candidate column this payment means —
      // previously every successful checkout.session.completed unconditionally flipped `tier`,
      // which was correct when this webhook only ever handled the one Verifi Pro product. A
      // license-tracking payment writes license_subscription_started_at instead — `tier`'s own check
      // constraint and meaning are specific to the free/paid resume tier, and a license-only
      // candidate never has a free resume tier to be "upgraded" from.
      const candidateId: string | null = session.client_reference_id || null;
      // 2026-09-19: this used to be `=== "license_tracking" ? "license_tracking" : "resume_pro"`, i.e. ANY other
      // product (including one that was never a candidate product) silently became a Verifi Pro upgrade for whichever
      // candidate the session's client_reference_id named. An explicit, different product is now refused here. A session
      // with NO product metadata (created before metadata[product] existed) keeps its old meaning, resume_pro.
      // Employer products never get this far: they are routed away above.
      const rawProduct = session.metadata?.product ?? null;
      const knownCandidateProduct = rawProduct === null || rawProduct === "" || rawProduct === "resume_pro" || rawProduct === "license_tracking";
      const product: string = rawProduct === "license_tracking" ? "license_tracking" : "resume_pro";
      if (!knownCandidateProduct) {
        summary.tierUpdate = { attempted: false, reason: "unrecognized_product", product: rawProduct };
      } else if (candidateId && session.payment_status === "paid") {
        try {
          // Subscription cancellation gap (2026-09-18): session.subscription is the real Stripe
          // subscription id (sub_...) Stripe attaches to a completed subscription-mode Checkout
          // session -- distinct from session.id (the checkout SESSION, cs_..., already captured
          // below). Captured here, once, at the same moment payment is first confirmed, because
          // this is the only place in the whole app that ever sees it: cancel-stripe-subscription
          // needs it to know which subscription to cancel, and the new customer.subscription.deleted
          // branch below needs it to match a cancellation event back to a candidate row. One column
          // serves both products -- account_type already keeps resume_pro and license_tracking
          // mutually exclusive per candidate (Items 9/10/11), so there's never a second live
          // subscription on the same row to disambiguate between.
          // stripe_subscription_cancelled_at is reset to null here, in the same write that records
          // the NEW subscription id — found live-testing Step 3: without this, a candidate who
          // cancelled once and later re-subscribed kept the OLD subscription's cancellation
          // timestamp, so candidate.html's next post-cancel poll (which just checks "is
          // stripe_subscription_cancelled_at set?") saw it immediately and reported "Billing
          // confirmed stopped" before Stripe had confirmed anything about the new subscription.
          // That fact has to describe the CURRENT subscription_id, never a previous one.
          const patchBody: Record<string, unknown> = {
            stripe_checkout_session_id: session.id || null,
            stripe_subscription_id: session.subscription || null,
            stripe_subscription_cancelled_at: null,
          };
          if (product === "license_tracking") {
            patchBody.license_subscription_started_at = new Date().toISOString();
          } else {
            patchBody.tier = "paid";
            patchBody.tier_updated_at = new Date().toISOString();
          }
          const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Prefer": "return=representation",
            },
            body: JSON.stringify(patchBody),
          });
          const patchRows = patchRes.ok ? await patchRes.json().catch(() => []) : [];
          summary.tierUpdate = {
            attempted: true,
            ok: patchRes.ok && Array.isArray(patchRows) && patchRows.length > 0,
            candidateId,
            product,
            status: patchRes.status,
          };
        } catch (e) {
          // Never fail the webhook response over this — Stripe retries a non-2xx, and a real
          // delivery success (signature verified, event parsed) shouldn't be reported as failed to
          // Stripe's own dashboard just because the downstream write hit a transient error. The
          // failure is still visible here, in this function's own invocation log and response body.
          summary.tierUpdate = { attempted: true, ok: false, candidateId, product, error: String(e) };
        }
      } else if (!candidateId) {
        summary.tierUpdate = { attempted: false, reason: "no_client_reference_id" };
      }
    }

    // Subscription cancellation gap (2026-09-18): the real confirmation half of cancel-stripe-
    // subscription (see that function's own header) -- that function only ever ASKS Stripe to cancel
    // (DELETE /v1/subscriptions/:id) and reports whether Stripe accepted the request, exactly the
    // same "don't trust the request, trust the webhook" split this file already draws for
    // checkout.session.completed/tier above. This is what actually confirms a subscription is gone,
    // matched back to a candidate by stripe_subscription_id (captured above at checkout time) since
    // the deleted-subscription event payload carries no candidate_id or client_reference_id of its
    // own -- only the subscription object itself.
    //
    // customer.subscription.updated is deliberately NOT handled here: an immediate DELETE cancel
    // (what cancel-stripe-subscription calls) always fires .deleted, never .updated -- .updated is
    // for other subscription changes (price/quantity edits, cancel_at_period_end being set without
    // an immediate cancel, etc.) this alpha's cancel flow never triggers. Handling it would mean
    // guessing at event shapes never seen from a real delivery, the same discipline that kept this
    // file's original signature-verification core to only what was actually proven against a real
    // Stripe event.
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data?.object || {};
      const subscriptionId: string | null = subscription.id || null;
      summary.subscriptionCancellation = { subscriptionId };
      if (subscriptionId) {
        try {
          const patchRes = await fetch(
            `${SUPABASE_URL}/rest/v1/candidates?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                "Prefer": "return=representation",
              },
              // tier is flipped here too, by the same webhook-confirmed fact — found live-testing
              // Step 3: deactivate-account never touches tier, so a paid candidate who deleted their
              // account kept tier = 'paid' against a subscription Stripe had actually cancelled, and
              // would have come back on reactivation showing Paid with nothing behind it. The match
              // is on the CURRENT stripe_subscription_id only (see the checkout.session.completed
              // branch above, which overwrites it on every new subscription), so a late-arriving
              // deleted event for an OLD subscription finds no row and can't downgrade a candidate
              // who has since re-subscribed. Idempotent with confirmDowngrade's own earlier
              // set-candidate-tier write; a license_only candidate's tier is never 'paid' to begin
              // with, so this is a no-op for them.
              //
              // license_subscription_started_at is cleared by the same confirmed fact: it is the
              // license-tracking product's equivalent of tier = 'paid' (this file's own
              // checkout.session.completed branch writes it INSTEAD of tier for that product), and
              // left set it makes candidate.html's Subscription tab keep saying "Active since ..." for
              // a subscription Stripe has cancelled. Cleared (not repurposed) so the existing
              // "No active subscription" state and applySession's licenseBilling routing — both
              // already keyed on this column being null — take over for a returning license-only
              // candidate. account_type keeps the two products mutually exclusive per candidate, so
              // for a resume_pro candidate this column is already null and this is a no-op.
              body: JSON.stringify({
                stripe_subscription_cancelled_at: new Date().toISOString(),
                tier: "free",
                tier_updated_at: new Date().toISOString(),
                license_subscription_started_at: null,
              }),
            },
          );
          const patchRows = patchRes.ok ? await patchRes.json().catch(() => []) : [];
          summary.subscriptionCancellation.attempted = true;
          summary.subscriptionCancellation.ok = patchRes.ok && Array.isArray(patchRows) && patchRows.length > 0;
          summary.subscriptionCancellation.status = patchRes.status;
        } catch (e) {
          // Same non-fatal posture as tierUpdate's own catch above — a real, verified delivery is
          // never reported failed to Stripe's dashboard over a transient downstream write error.
          summary.subscriptionCancellation.attempted = true;
          summary.subscriptionCancellation.ok = false;
          summary.subscriptionCancellation.error = String(e);
        }
      } else {
        summary.subscriptionCancellation.attempted = false;
        summary.subscriptionCancellation.reason = "no_subscription_id_on_event";
      }
    }

    // Candidate branch done (its own write failures never fail the delivery, see above): mark the event processed.
    await rpcDone("finish_stripe_event", "candidate");
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }),
};
