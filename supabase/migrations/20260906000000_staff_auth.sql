-- Real staff authentication, replacing staff.html's self-selected "Sign in as" role picker (zero
-- access control today: logIn() reads only the dropdown, never the email/password inputs, which
-- are decorative — confirmed live before writing this, not assumed).
--
-- Mirrors, not reuses, the candidate passwordless-login pattern (login_tokens/candidate_sessions,
-- 20260904020000_passwordless_login.sql): confirmed that candidate_sessions.candidate_id is a real
-- NOT NULL foreign key to candidates(id), and login_tokens.candidate_id likewise references
-- candidates(id) — direct reuse for a non-candidate identity would mean weakening a working, tested
-- constraint, not a style choice. Same shape, own tables.
--
-- Deliberately no cross-device polling step (no check-login-status / issue_requester_session
-- equivalent) — staff logging into an internal tool overwhelmingly click the link on the same
-- device that requested it, unlike candidate signup/login which explicitly designed for the
-- cross-device case. Four functions cover it: staff-request-login, staff-confirm-login,
-- staff-resolve-session, staff-logout.

-- staff_users: the roster itself. No self-service creation by design — rows are added directly via
-- SQL as real staff are brought on; a full invite/manage UI is explicitly deferred, not an
-- oversight. `name` sits alongside email/role for one specific, confirmed-necessary reason: the
-- existing (and untouched) per-worker queue scoping in staff.html compares
-- `verification_items.assigned_to` (a value drawn from the hardcoded WORKERS dropdown, e.g.
-- "Jordan Lee") against `currentUser`. Once currentUser comes from a real resolved session instead
-- of a self-typed name, it has to still be that same display string, not an email address, or that
-- scoping silently breaks.
create table staff_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'worker')),
  created_at timestamptz not null default now()
);

-- staff_login_tokens: same shape as login_tokens — a one-time, short-lived link, single-use via an
-- atomic guarded UPDATE (confirmed_at IS NULL) in staff-confirm-login, not a check-then-write race.
create table staff_login_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token text not null unique,
  staff_user_id uuid references staff_users(id),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz
);

create index staff_login_tokens_token_idx on staff_login_tokens(token);
create index staff_login_tokens_email_idx on staff_login_tokens(email);

-- staff_sessions: real, persisted access across visits — one row per device, independently
-- revocable, only the hash ever stored (mirrors candidate_sessions exactly on this point).
create table staff_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references staff_users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index staff_sessions_token_hash_idx on staff_sessions(token_hash);
create index staff_sessions_staff_user_id_idx on staff_sessions(staff_user_id);

grant all on staff_users to service_role;
grant all on staff_login_tokens to service_role;
grant all on staff_sessions to service_role;
