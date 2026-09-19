-- Employer accounts and sessions (2026-09-19): the identity layer Tier 2 (paid comparison, org billing)
-- depends on. Same passwordless shape as candidates and staff (login_tokens/candidate_sessions,
-- staff_login_tokens/staff_sessions): a short-lived single-use login token claimed atomically, and a
-- long-lived session whose token is only ever stored hashed. Its own tables, not shared with either: the
-- candidate and staff tables carry NOT NULL foreign keys to their own user tables.
--
-- Where it deliberately differs from those two:
--   * Open self-serve signup: the account is created when the FIRST login link is confirmed, so there is one
--     "enter your email" flow. employer_login_tokens therefore has no user id (the user may not exist yet);
--     requested_name carries the name typed at first sign-in.
--   * Orgs: employer_orgs + employer_users.org_id/role. A person belongs to at most ONE org (email is unique
--     across all orgs). Role is 'owner' or 'member'; the owner is the billing owner AND the only admin, by
--     decision, no separate tiers. Exactly one owner per org is enforced HERE, in the database, by a partial
--     unique index, not only in application code.
--   * Invites: an owner adds people by email; the invitee logs in normally (the login link already proves they
--     control the address), sees the pending invite, and must accept it explicitly. Nobody is attached to an org
--     without acting.
--   * Authorization is derived from live database state on every call (org and role are read from
--     employer_users, never from the session row or the request), so removing a member cuts their org access
--     immediately without needing to revoke sessions.
--
-- Not built here on purpose: handing the owner role to someone else, or the owner leaving. That belongs with the
-- Stripe pass (billing is attached to the owner); until then the owner cannot be removed and cannot leave.

create table if not exists employer_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  created_at timestamptz not null default now()
);

create table if not exists employer_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text,
  org_id uuid references employer_orgs(id) on delete set null,
  role text check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  -- role exists exactly when the user belongs to an org
  constraint employer_users_org_role_consistent check ((org_id is null) = (role is null))
);
-- Exactly one owner per org.
create unique index if not exists employer_users_one_owner_per_org on employer_users (org_id) where role = 'owner';
create index if not exists employer_users_org_idx on employer_users (org_id);

create table if not exists employer_login_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_name text,
  token text not null unique,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz
);
create index if not exists employer_login_tokens_email_idx on employer_login_tokens (email, requested_at);

create table if not exists employer_sessions (
  id uuid primary key default gen_random_uuid(),
  employer_user_id uuid not null references employer_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists employer_sessions_user_idx on employer_sessions (employer_user_id);

create table if not exists employer_org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references employer_orgs(id) on delete cascade,
  email text not null check (email = lower(email)),
  invited_by uuid references employer_users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz
);
create unique index if not exists employer_org_invites_one_pending on employer_org_invites (org_id, email) where status = 'pending';
create index if not exists employer_org_invites_email_idx on employer_org_invites (email) where status = 'pending';

grant select, insert, update, delete on table employer_orgs to service_role;
grant select, insert, update, delete on table employer_users to service_role;
grant select, insert, update, delete on table employer_login_tokens to service_role;
grant select, insert, update, delete on table employer_sessions to service_role;
grant select, insert, update, delete on table employer_org_invites to service_role;

-- Housekeeping: used/expired login tokens after a day, long-dead sessions, resolved invites after 90 days.
create or replace function cleanup_employer_auth() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer := 0; k integer;
begin
  delete from employer_login_tokens where expires_at < now() - interval '1 day';
  get diagnostics k = row_count; n := n + k;
  delete from employer_sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days';
  get diagnostics k = row_count; n := n + k;
  delete from employer_org_invites where (status <> 'pending' and responded_at < now() - interval '90 days') or expires_at < now() - interval '90 days';
  get diagnostics k = row_count; n := n + k;
  return n;
end;
$$;
grant execute on function cleanup_employer_auth() to service_role;

select cron.schedule('cleanup-employer-auth', '27 * * * *', $$select public.cleanup_employer_auth()$$);
