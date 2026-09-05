-- Split candidate name collection from a single full_name field into first_name/last_name.
-- Run through the same dashboard SQL editor as every other schema change in this project (no
-- CLI/migrations linkage), committed here as the durable record, matching the discipline already
-- established in 20260903000000_resume_pipeline.sql's own header.
--
-- full_name is deliberately left in place on both tables, not dropped: existing rows (every
-- candidate who signed up before this change) only ever had full_name populated, and nothing here
-- backfills it into first_name/last_name. Any code that displays a candidate's name needs to
-- handle both shapes going forward — first_name/last_name preferred, full_name as the fallback for
-- pre-existing rows. See send-verification / confirm-verification (write side, now first_name/
-- last_name only) and resolve-session / confirm-login / check-login-status / list-verification-items
-- (read side, updated to select and return both, concatenating for display).

alter table email_verifications add column if not exists first_name text;
alter table email_verifications add column if not exists last_name text;

alter table candidates add column if not exists first_name text;
alter table candidates add column if not exists last_name text;

-- Real bug caught live on the first actual end-to-end test of this change: candidates.full_name
-- was NOT NULL. confirm-verification's candidates insert no longer writes full_name at all (see
-- that function's own header), so every real signup failed outright with a 23502 not-null
-- violation until this ran. email_verifications.full_name was already nullable — only candidates
-- had the constraint.
alter table candidates alter column full_name drop not null;
