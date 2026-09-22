-- Guest payment: authorize-then-capture (2026-09-22). The Checkout Session now places a hold on the card (capture_method
-- manual, card only: Apple Pay/Google Pay still work since Stripe presents them as card) instead of charging immediately.
-- The real charge is a separate, later capture, made only at genuine redemption (employer-comparison's `enter` action,
-- the same idempotent visit-the-link action already built). Two new terminal states on employer_payments.status:
--   'authorized' -- the hold succeeded (payment_intent.amount_capturable_updated). Capturable; nothing charged yet.
--   'expired'    -- the hold's own window (about 7 days for a card, customer-initiated) ran out uncaptured
--                   (payment_intent.canceled) and Stripe released it by itself. Nothing was ever charged and nothing
--                   needs a refund: distinct from 'failed' (a card actually declined at authorization) and from
--                   'needs_review' (a captured amount that did not match).
-- This eliminates the previous paid-but-never-opened case structurally: nothing is ever captured without a genuine
-- redemption, so an un-redeemed hold simply expires with zero money ever having moved.
alter table employer_payments drop constraint employer_payments_status_check;
alter table employer_payments add constraint employer_payments_status_check
  check (status in ('created', 'authorized', 'paid', 'failed', 'refunded', 'needs_review', 'expired'));

alter table employer_payments add column if not exists authorized_at timestamptz;
