-- Items 9/10/11 (2026-09-13 live-testing session): the license-only signup path, as its own branch
-- of the existing full-resume flow rather than a separate product. account_type is the single field
-- everything downstream (signup routing, the reduced account-tab set, Subscription-tab content)
-- branches on -- confirmed with the user before building: not a separate file or route.
--
-- Default 'full_resume' so every existing candidate row (and every code path that doesn't yet know
-- about this column) keeps behaving exactly as it does today -- this is an additive branch, not a
-- reclassification of existing accounts.
alter table candidates add column if not exists account_type text not null default 'full_resume';
alter table candidates drop constraint if exists candidates_account_type_check;
alter table candidates add constraint candidates_account_type_check check (account_type in ('full_resume', 'license_only'));

-- kyc_verified_at (Item 10): confirmed live before this migration that kycVerified in candidate.html
-- is PURE client state today -- never read from or written to the database, resets on every reload.
-- That's harmless today because KYC is "purely informational" for full-resume accounts (see the
-- Profile Info card's own copy) and never gates anything. Item 10 makes KYC a REQUIRED step in the
-- license-only signup sequence, which means it needs to be real and durable, not just an in-memory
-- flag that a page refresh mid-signup would silently erase. Written once, at confirm-verification
-- time, for a license-only signup that passed through the (still simulated-vendor) KYC step --
-- exactly the same "simulate verification complete" honesty posture the KYC modal already has, just
-- now with a real, persisted timestamp behind it instead of nothing at all.
alter table candidates add column if not exists kyc_verified_at timestamptz;

-- license_subscription_started_at (Item 10): the license-tracking recurring-subscription counterpart
-- to tier_updated_at (candidate_tier migration) -- set by test-stripe-webhook once a license-tracking
-- Checkout session actually completes with payment_status 'paid'. Deliberately its own column, not a
-- repurposing of `tier` (that column's check constraint and its own meaning are specific to the
-- free/paid RESUME tier -- a license-only candidate never has a "free" resume tier to be on).
alter table candidates add column if not exists license_subscription_started_at timestamptz;

-- === email_verifications: pre-confirmation staging, same discipline as first_name/opt_in_* already
-- use on this table -- candidates rows are only ever created at confirm-verification time (see that
-- migration's own header), so anything collected earlier in signup (name, phone, resume opt-ins, and
-- now account_type + a license-only candidate's KYC/license entries) has to be staged here first and
-- read back by confirm-verification once a real candidate_id exists. ===
alter table email_verifications add column if not exists account_type text;
alter table email_verifications drop constraint if exists email_verifications_account_type_check;
alter table email_verifications add constraint email_verifications_account_type_check check (account_type is null or account_type in ('full_resume', 'license_only'));

-- staged_license (Item 10): the license-only signup's equivalent of a certification_items row, held
-- as one jsonb blob (same convention already used for extraction jsonb elsewhere in this project)
-- rather than six new narrow columns for a single one-time staging use. Shape:
-- { name, issuing_body, license_number, trade_soc_code, issue_date, expiration_date } -- the exact
-- same field set as Item 8's certification card, reused verbatim, not a new taxonomy. Null for every
-- full-resume signup.
alter table email_verifications add column if not exists staged_license jsonb;
