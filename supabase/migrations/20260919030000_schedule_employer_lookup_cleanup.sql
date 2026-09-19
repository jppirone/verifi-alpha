-- Runs cleanup_expired_employer_lookups() automatically (it existed but nothing called it). Unconfirmed
-- lookup requests hold the third-party details the requester typed (candidate name/email/phone); the
-- function removes them one day after their link expired, and drops every request row after 30 days.
-- Hourly is cheap (an index-free delete over a tiny table) and bounds how long typed details can sit at
-- roughly 25 hours past expiry.
--
-- pg_cron is a Supabase-supported extension; it lives in pg_catalog and its jobs run as the role that
-- scheduled them. cron.schedule with an existing job name replaces that job, so re-running this is safe.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'cleanup-expired-employer-lookups',
  '17 * * * *',
  $$select public.cleanup_expired_employer_lookups()$$
);
