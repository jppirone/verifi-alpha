-- Master feed pause (2026-09-21).
--
-- One candidate-level switch, not tied to any partner (none exist yet): "do not include my data in any licensed feed". Stored as a timestamp so the state and
-- the moment it was set are one fact (null = not paused; the value = when the candidate paused). Written only through the candidate-feed-pause Edge Function
-- (candidate's own session, or the service role); the anon/authenticated API roles have no grant on this column beyond what the candidates table already gives them.
--
-- The contract for any future feed: a candidate is includable only when feed_paused_at IS NULL (and the account is not deactivated). Nothing consumes it yet;
-- it is set correctly from day one so the first real feed cannot start out including someone who already opted out.
--
-- Additive, nullable, no default: every existing row is left exactly as it was (not paused, which is also what "no choice made yet" has always meant here:
-- there is no feed, so there is nothing to have opted in to).

alter table candidates add column if not exists feed_paused_at timestamptz;

comment on column candidates.feed_paused_at is 'Master feed pause: when the candidate turned on "do not include my data in any licensed feed"; null = not paused. Any future feed must exclude rows where this is not null.';
