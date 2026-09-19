-- Resume files are now actually deleted from Storage (2026-09-20).
--
-- THE GAP. 20260919040000 made cleanup_expired_unconfirmed_resume_data() record each abandoned document's file paths in
-- resume_storage_purge_queue before deleting its row (a Postgres function cannot call the Storage API), and said "NOTHING PURGES THAT
-- QUEUE YET". Nothing ever did, so the copy "unconfirmed uploads and files auto-delete" was true for database rows and false for the
-- actual PDFs: 261 of the 262 files in the resume-documents bucket had no database row at all.
--
-- THE FIX has three parts.
--  1. purge-resume-storage (Edge Function): drains the queue through the Storage API, re-checking first that no resume_documents row
--     points at the path. Run every 15 minutes by the pg_cron job below, over pg_net.
--  2. The same function's "reconcile" mode: lists (dry run by default) or deletes files that no row references, for the one-time backfill
--     of files orphaned before the queue existed or by deletes that never went through it. It only deletes an explicit list, and only paths
--     it re-verifies as orphans at that moment (older than a minimum age, laid out as <owner>/<document>/<file>, and whose owner folder is
--     not a live candidate, verification, or document owner).
--  3. list_orphan_resume_objects(): the one definition of "orphan" both modes share.
--
-- AUTH. The function must not be publicly callable, and cron cannot be handed the service-role key. A random secret is generated HERE,
-- kept only in internal_job_secrets (no API role can read it), read by the cron command inside the database and by the function with its
-- own service role, and compared in constant time. The cron request also carries the public publishable key only to get past the gateway.

create extension if not exists pg_net;

create table if not exists internal_job_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table internal_job_secrets enable row level security;   -- no policies: anon/authenticated can read nothing
revoke all on table internal_job_secrets from anon, authenticated;
grant select on table internal_job_secrets to service_role;
insert into internal_job_secrets (name, value)
  values ('purge_resume_storage', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

-- Files in the bucket that nothing references. "Referenced" = a resume_documents row names the path, or is the document folder the path
-- sits in. p_strict (used by the backfill) adds: the standard <owner>/<document>/(original.<ext>|sanitized.jpg) layout, and an owner folder
-- that is not a live candidate, email verification, or document owner. p_min_age keeps files from an upload still in flight.
create or replace function list_orphan_resume_objects(p_min_age interval default interval '24 hours', p_strict boolean default true)
returns table(name text, created_at timestamptz, size bigint, standard_layout boolean)
language sql
stable
security definer
set search_path = public, storage
as $$
  select o.name, o.created_at, nullif(o.metadata->>'size', '')::bigint,
         o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(original\.[a-z]+|sanitized\.jpg)$'
  from storage.objects o
  where o.bucket_id = 'resume-documents'
    and o.created_at < now() - p_min_age
    and not exists (select 1 from resume_documents rd
                    where rd.original_storage_path = o.name or rd.sanitized_render_path = o.name or rd.id::text = split_part(o.name, '/', 2))
    and (not p_strict or (
          o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(original\.[a-z]+|sanitized\.jpg)$'
          and not exists (select 1 from candidates c where c.id::text = split_part(o.name, '/', 1))
          and not exists (select 1 from email_verifications ev where ev.id::text = split_part(o.name, '/', 1))
          and not exists (select 1 from resume_documents rd
                          where rd.candidate_id::text = split_part(o.name, '/', 1) or rd.email_verification_id::text = split_part(o.name, '/', 1))
        ))
$$;
revoke all on function list_orphan_resume_objects(interval, boolean) from public, anon, authenticated;
grant execute on function list_orphan_resume_objects(interval, boolean) to service_role;

select cron.schedule(
  'purge-resume-storage',
  '*/15 * * * *',
  $$select net.http_post(
      url := 'https://ihmypoduvrzymasgactc.supabase.co/functions/v1/purge-resume-storage',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'Authorization', 'Bearer sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'x-purge-secret', (select value from public.internal_job_secrets where name = 'purge_resume_storage')
      ),
      body := '{"mode":"queue"}'::jsonb,
      timeout_milliseconds := 30000
    )$$
);
