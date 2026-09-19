-- Candidate login / signup without an account-existence oracle (2026-09-19).
--
-- request-login used to answer 404 "no account found" for an unknown address, check-duplicate-account answered
-- {exists: true|false} for any address, and neither (nor send-verification) had a rate limit. All three now answer
-- identically whether or not the address has an account, so their rate limit cannot depend on that either:
-- login_tokens only ever holds rows for real candidates, so it cannot be what is counted. Every request, known
-- address or not, is recorded here instead, and the per-address / global hourly ceilings are computed from this table.
--
-- The id doubles as the polling handle: request-login returns this row's id as login_token_id for EVERY address, and
-- for a real candidate the login_tokens row is created with the SAME id (after the response is sent). check-login-status
-- therefore answers "pending" from this table when no login_tokens row exists, so polling cannot tell the two apart.

create table if not exists candidate_login_attempts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null default 'login',      -- 'login' (request-login) | 'signup' (send-verification)
  requested_at timestamptz not null default now()
);
create index if not exists candidate_login_attempts_email_idx on candidate_login_attempts (email, requested_at);
create index if not exists candidate_login_attempts_time_idx on candidate_login_attempts (requested_at);

-- Every table this project adds needs this explicit grant: the API roles get no default table privileges here.
grant select, insert, update, delete on table candidate_login_attempts to service_role;

-- A signup link clicked for an address that already has an account signs that existing account in (the link only ever
-- reaches the address's owner) instead of creating one. The verification row records which account it signed in, so the
-- device that stayed on "Check your email" and polled can be given the same session (see check-verification-status).
alter table email_verifications add column if not exists existing_candidate_id uuid references candidates(id) on delete set null;
