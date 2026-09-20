-- Comparison sweep (2026-09-20): every 15 minutes, offset from the resume-storage jobs (:00/:08/:15/:23...) so none start together.
-- The candidate-comparison-requests function's "sweep" action expires requests nobody answered (72 h), discards approved snapshots that
-- were never opened (7 days) or whose retention ended (90 days for accounts), sends the undifferentiated "not authorized" email for
-- requests that ended without approval, and retries "you have a request" emails that failed at creation.
-- Same authentication as the storage jobs: the secret is read inside the database from internal_job_secrets ('comparison_sweep').
select cron.schedule(
  'sweep-comparison-requests',
  '4,19,34,49 * * * *',
  $$select net.http_post(
      url := 'https://ihmypoduvrzymasgactc.supabase.co/functions/v1/candidate-comparison-requests',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'Authorization', 'Bearer sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'x-comparison-secret', (select value from public.internal_job_secrets where name = 'comparison_sweep')
      ),
      body := '{"action":"sweep"}'::jsonb,
      timeout_milliseconds := 60000
    )$$
);
