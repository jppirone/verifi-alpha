-- Schedules cleanup_expired_unconfirmed_resume_data() (it has never had a scheduler) and closes two gaps
-- found checking it before scheduling. (The license_items delete order it needs was already added by
-- 20260918020000_license_items.sql; verified live: an abandoned signup with a detected license is removed.)
--
-- 1. Orphaned files. The uploaded original / sanitized render live in Storage (bucket resume-documents).
--    A Postgres function can not call the Storage API, and once the resume_documents row is deleted the
--    file paths are gone, so the files would be unreachable forever. Paths are now written to
--    resume_storage_purge_queue before the row is deleted. NOTHING PURGES THAT QUEUE YET: removing the
--    files needs a Storage-API caller (an Edge Function). Until one exists the queue is the list of files
--    to remove, not a deletion.
-- 2. One bad document no longer blocks the sweep: each abandoned document is cleaned in its own
--    sub-transaction and skipped with a warning on any error. Documents a verification_items row already
--    points at (bundle_id) are left alone: they belong to a queue item staff may hold.
create table if not exists resume_storage_purge_queue (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'resume-documents',
  path text not null,
  queued_at timestamptz not null default now(),
  purged_at timestamptz
);
create unique index if not exists resume_storage_purge_queue_path_key on resume_storage_purge_queue (bucket, path);
grant select, insert, update, delete on table resume_storage_purge_queue to service_role;

create or replace function cleanup_expired_unconfirmed_resume_data() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_orig text;
  v_san text;
begin
  for v_id, v_orig, v_san in
    select rd.id, rd.original_storage_path, rd.sanitized_render_path
    from resume_documents rd
    join email_verifications ev on ev.id = rd.email_verification_id
    where rd.candidate_id is null and ev.confirmed_at is null and ev.expires_at < now()
      and not exists (select 1 from verification_items vi where vi.bundle_id = rd.id)
  loop
    begin
      insert into resume_storage_purge_queue (path)
        select p from unnest(array[v_orig, v_san]) as p where p is not null
        on conflict (bucket, path) do nothing;
      delete from license_items
        where resume_document_id = v_id
           or linked_certification_id in (select id from certification_items where resume_document_id = v_id);
      delete from work_history_items where resume_document_id = v_id;
      delete from education_items where resume_document_id = v_id;
      delete from certification_items where resume_document_id = v_id;
      delete from skill_items where resume_document_id = v_id;
      delete from candidate_freeform_sections where resume_document_id = v_id;
      delete from resume_documents where id = v_id;
    exception when others then
      raise warning 'cleanup_expired_unconfirmed_resume_data: skipped resume_document %: %', v_id, sqlerrm;
    end;
  end loop;
end;
$$;

grant execute on function cleanup_expired_unconfirmed_resume_data() to service_role;

select cron.schedule(
  'cleanup-expired-unconfirmed-resume-data',
  '47 * * * *',
  $$select public.cleanup_expired_unconfirmed_resume_data()$$
);
