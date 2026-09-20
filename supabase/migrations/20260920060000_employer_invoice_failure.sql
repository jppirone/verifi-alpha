-- Employer comparison delivery, Stage 4 (2026-09-20): failed-invoice handling for org subscriptions.
--
-- A renewal that cannot be charged already stops lookups (consume_org_lookup only serves 'active' and 'trialing', and Stripe moves the
-- subscription to past_due), but until now nobody was told and the page said nothing. These columns record the failure so it can be
-- shown and emailed exactly once:
--   payment_failed_at              when the first failed attempt for the CURRENT failed invoice was recorded (cleared when an invoice is paid)
--   last_failed_invoice_id         which Stripe invoice failed
--   failure_notified_invoice_id    the invoice the owner has already been emailed about: Stripe retries a failed invoice several times
--                                  and each retry is a new event, so the email is claimed per INVOICE, not per event
--   last_invoice_event_created     Stripe time of the last invoice event applied: an older event never overwrites newer state
alter table employer_org_subscriptions
  add column if not exists payment_failed_at timestamptz,
  add column if not exists last_failed_invoice_id text,
  add column if not exists failure_notified_invoice_id text,
  add column if not exists last_invoice_event_created bigint not null default 0;
