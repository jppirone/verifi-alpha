-- Item B (2026-09-08 regression session): real backend state for candidate tier (free/paid),
-- replacing accountTier — 100% local React state that toggled via a dev-only "Demo: tier ="
-- button and a fully-simulated "Confirm payment" click, never anything real. Maps to a real,
-- decided concept (Decision 28's Content Manager paid-tier gating, and the editable-Summary-
-- variants feature decided to stay paid-tier-only) — this was always real scope, just never wired
-- past a local toggle.
--
-- tier_updated_at is WHEN it last changed (either direction — a real Stripe test-mode payment via
-- test-stripe-webhook, or a self-service downgrade via set-candidate-tier), for basic auditability,
-- same pattern as deletion_scheduled_at. stripe_checkout_session_id records the most recent
-- checkout.session.completed id that set tier='paid', so a real payment can be traced back to a
-- real Stripe test-mode session from this row alone.
alter table candidates add column if not exists tier text not null default 'free' check (tier in ('free', 'paid'));
alter table candidates add column if not exists tier_updated_at timestamptz;
alter table candidates add column if not exists stripe_checkout_session_id text;
