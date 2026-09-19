-- Staff login without an account-existence oracle (2026-09-19).
--
-- staff-request-login used to answer 404 "no account found" for an address with no staff_users row and had no
-- rate limit, so anyone could enumerate which addresses are staff. It now answers identically whether or not the
-- address is a staff account (like employer-request-login), so its rate limit cannot depend on whether the address
-- exists either. staff_login_tokens only gets a row for a real staff account, so it cannot be the thing that is
-- counted; every request, known address or not, is recorded here instead and the per-address / global hourly
-- ceilings are computed from this table.

create table if not exists staff_login_attempts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_at timestamptz not null default now()
);
create index if not exists staff_login_attempts_email_idx on staff_login_attempts (email, requested_at);
create index if not exists staff_login_attempts_time_idx on staff_login_attempts (requested_at);

-- Every table this project adds needs this explicit grant: the API roles get no default table privileges here.
grant select, insert, update, delete on table staff_login_attempts to service_role;
