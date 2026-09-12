-- Item 20 (2026-09-12 live-testing session): check-verification-status (the device that stayed on
-- "Check your email" and polls -- Device A in a cross-device signup, exact same shape as passwordless
-- login's Device A) never issued a real, persisted session at all -- confirmed live: its response
-- never included session_token, so applySignupConfirmation's own `await this.applySession(data.
-- session_token, data)` call always ran with sessionToken undefined on this path. Device B (the one
-- that actually clicks the email link, confirm-verification) already issues a real session -- see
-- that function's own Item 2 header -- so this was a real asymmetry, not a designed difference: a
-- candidate who signs up on a laptop and confirms via the link opened on their phone gets a durable
-- session on the phone but the laptop that started the flow and stayed on-screen watching it resolve
-- gets nothing durable, silently falling back to whatever pre-session behavior existed before Item 2.
--
-- Fix mirrors passwordless login's own Device A mechanism exactly (issue_requester_session /
-- login_tokens.requester_session_id/requester_session_token, see 20260904020000_passwordless_login.sql)
-- rather than a naive "just issue a session on every poll" fix: check-verification-status is polled on
-- a fixed interval (startCheckEmailPolling, every 12s) and only stops once confirmed is observed true --
-- a real race exists between "this poll sees confirmed_at set" and "the client's next call to
-- stopCheckEmailPolling actually lands" (plus a genuine retry if a response is lost in transit), so an
-- unguarded "insert a candidate_sessions row every time this branch runs" would risk issuing multiple
-- sessions for the same confirmation. The atomic claim-once-then-reserve pattern already proven for
-- login_tokens is reused verbatim, just against email_verifications instead.

alter table email_verifications add column if not exists requester_session_id uuid;
alter table email_verifications add column if not exists requester_session_token text;

-- Identical shape and reasoning to issue_requester_session (passwordless login's own RPC) -- see that
-- function's own header for the full concurrency argument. Deliberately a separate function rather
-- than a generalized one keyed by table name: Postgres has no clean way to parameterize which table an
-- UPDATE/INSERT targets without dynamic SQL, and email_verifications' row is looked up by id (not a
-- token string) since check-verification-status's caller only ever has email_verification_id -- close
-- enough in shape to login_tokens' version that a shared function would need conditionals anyway.
create or replace function issue_verification_requester_session(
  p_email_verification_id uuid,
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
  update email_verifications
  set requester_session_id = p_session_id, requester_session_token = p_raw_token
  where id = p_email_verification_id and confirmed_at is not null and requester_session_id is null;

  if found then
    insert into candidate_sessions (id, candidate_id, token_hash, created_at, last_seen_at, expires_at)
    values (p_session_id, p_candidate_id, p_token_hash, now(), now(), p_expires_at);
    return query select p_raw_token, false;
    return;
  end if;

  return query
    select ev.requester_session_token, true
    from email_verifications ev
    where ev.id = p_email_verification_id;
end;
$$;

grant execute on function issue_verification_requester_session(uuid, uuid, uuid, text, text, timestamptz) to service_role;
