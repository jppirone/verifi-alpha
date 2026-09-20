-- Scheduled sweep for stray resume files (2026-09-20).
--
-- purge-resume-storage's "queue" mode (every 15 minutes) only removes files whose paths the cleanup job queued. A file left behind by a
-- failed upload never gets queued: upload-resume stores the file first and inserts the resume_documents row after, so if the insert fails
-- (or only one of its two uploads succeeds) there is a file and no row, and nothing ever learns of it. The function's "sweep" mode is the
-- standing net for those: it deletes a file only if it is in the standard <owner>/<document>/<file> layout, no resume_documents row names it
-- or is its document folder (re-checked per file immediately before deleting), and it is older than 24 hours so an upload in flight is never
-- touched. See the function's header for why this is not the strict owner-folder rule the one-time backfill used.
--
-- Same 15-minute cadence as the queue drain, offset by 8 minutes so the two never start in the same minute. The age limit, not the
-- cadence, is what bounds how long a stray survives (about 24 hours), so a slower cadence would work equally well; 15 minutes keeps it uniform.
-- Same authentication as the queue job: the secret is read inside the database from internal_job_secrets.

select cron.schedule(
  'sweep-resume-storage',
  '8,23,38,53 * * * *',
  $$select net.http_post(
      url := 'https://ihmypoduvrzymasgactc.supabase.co/functions/v1/purge-resume-storage',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'Authorization', 'Bearer sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'x-purge-secret', (select value from public.internal_job_secrets where name = 'purge_resume_storage')
      ),
      body := '{"mode":"sweep"}'::jsonb,
      timeout_milliseconds := 60000
    )$$
);
