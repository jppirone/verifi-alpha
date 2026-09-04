-- Passwordless login: replaces the leftover simulated password-prompt screen (candidate.html's
-- isReturning block, never wired to any backend — goAccount() ignored whatever was typed and
-- unconditionally "logged in") with a real, email-link-based login, extending the exact pattern
-- already proven tonight for signup confirmation (email_verifications + confirm-verification).
--
-- Two tables, deliberately separate from email_verifications (not a purpose:'login' reuse):
-- confirm-verification's real code branches on purpose === 'signup' to INSERT a new candidate —
-- a login token's job is to look UP an existing one, a different enough operation that layering
-- it into that already-tested, working function risks regressing signup confirmation for no real
-- benefit. A separate table keeps both flows independently legible and safe to change.

-- login_tokens: the one-time, short-lived link a candidate clicks to prove they still control
-- their email (or, later, phone — see `channel`). Mirrors email_verifications' shape closely, but
-- adds real replay protection at the point requested tonight: a login token must be single-use,
-- and the atomicity has to be real (an UPDATE ... WHERE confirmed_at IS NULL, not a SELECT-then-
-- PATCH race), because unlike a duplicate candidates INSERT (which the real database's own unique
-- constraint on candidates.email already catches), there is no natural constraint that would stop
-- a double-consumed login token from silently issuing two sessions.
create table login_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  channel text not null default 'email',   -- 'email' today; 'sms' later reuses this same table/flow
                                            -- unchanged, per the channel-agnostic design — nothing
                                            -- about this schema or the functions built against it is
                                            -- email-specific by name, only by which channel a given
                                            -- row happens to use.
  token text not null unique,
  candidate_id uuid references candidates(id),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,                -- set exactly once, by the atomic guarded UPDATE in
                                            -- confirm-login — this is the real single-use guard.
  -- The requesting device (Device A) needs its OWN real, persisted session too, not just a
  -- transient "confirmed" flag that vanishes on refresh — set once, by issue_requester_session(),
  -- the first time Device A's poll observes confirmed_at set. requester_session_token is kept
  -- plaintext and re-servable on this row deliberately (not hashed-and-forgotten): this table is
  -- itself short-lived and single-purpose exactly like email_verifications.token already is
  -- (plaintext there too, the established precedent this project already ships), so a repeat poll
  -- that arrives after the first response was lost in transit can still recover the same real
  -- session rather than being stuck with no way to log in on the device that started the flow.
  requester_session_id uuid,
  requester_session_token text
);

create index login_tokens_token_idx on login_tokens(token);
create index login_tokens_email_idx on login_tokens(email);

-- candidate_sessions: the real, persisted access a confirmed candidate now has across visits and
-- devices — the actual gap Part 1 confirmed exists nowhere today (real access previously lived
-- only in transient React state set once by confirmEmailToken(), gone the instant a device or tab
-- changed). One row per device/browser that has ever logged in, each independently revocable.
-- Unlike login_tokens.token (single-use, minutes-scale lifetime), this token is long-lived by
-- design — a stolen raw value here is a real, standing risk — so only its hash is ever stored;
-- the raw token is returned once, in the confirm-login/check-login-status response body, and never
-- persisted anywhere in plaintext.
create table candidate_sessions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index candidate_sessions_token_hash_idx on candidate_sessions(token_hash);
create index candidate_sessions_candidate_id_idx on candidate_sessions(candidate_id);

grant all on login_tokens to service_role;
grant all on candidate_sessions to service_role;

-- Atomically claims Device A's own session the first time confirmed_at is observed set, and only
-- ever the first time — the UPDATE's WHERE requester_session_id IS NULL is the real concurrency
-- guard (Postgres row-level locking makes exactly one concurrent caller win it), not an
-- application-level check-then-write race. A caller that loses the race (or simply polls again
-- after already succeeding) gets the SAME already-issued token back via the final SELECT, not a
-- second session and not an error — matching the same "no reachable case with zero feedback"
-- standard the rest of tonight's work holds to.
--
-- Randomness and hashing happen in the calling Edge Function (Deno's Web Crypto), not in this
-- function, deliberately: it keeps this function's only job "atomically claim or return the
-- existing claim," with no dependency on pgcrypto being enabled on this database.
create or replace function issue_requester_session(
  p_login_token_id uuid,
  p_candidate_id uuid,
  p_session_id uuid,
  p_raw_token text,
  p_token_hash text,
  p_expires_at timestamptz
) returns table(session_token text, already_issued boolean)
language plpgsql
security definer
as $$
begin
  update login_tokens
  set requester_session_id = p_session_id, requester_session_token = p_raw_token
  where id = p_login_token_id and confirmed_at is not null and requester_session_id is null;

  if found then
    insert into candidate_sessions (id, candidate_id, token_hash, created_at, last_seen_at, expires_at)
    values (p_session_id, p_candidate_id, p_token_hash, now(), now(), p_expires_at);
    return query select p_raw_token, false;
    return;
  end if;

  return query
    select lt.requester_session_token, true
    from login_tokens lt
    where lt.id = p_login_token_id;
end;
$$;

grant execute on function issue_requester_session(uuid, uuid, uuid, text, text, timestamptz) to service_role;
