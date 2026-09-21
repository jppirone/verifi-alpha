-- Resume resubmission, STAGE 3 (2026-09-21): expiry of unfinished attempts.
--
-- An attempt the candidate never finishes (started and abandoned, extracting, or waiting on the review screen) holds staged rows and a stored file
-- that are nobody's profile. After 7 days without activity it is expired: its staged upload is discarded (rows through the existing discard RPC, the
-- stored files through the existing purge queue) and the attempt is marked 'expired'. A FAILED attempt is kept the same 7 days so staff can still see
-- the failure in their report, then cleaned the same way.
--
-- It can only ever touch an UNCONFIRMED document of kind 'resubmission'. An applied attempt, a confirmed document, an initial document and the
-- candidate's profile are never selected. Hourly, like the other cleanup jobs.
create or replace function expire_resume_resubmissions() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; docs int := 0;
begin
  for r in
    select rs.id, rs.candidate_id, rs.resume_document_id from resume_resubmissions rs
    where rs.status in ('uploading', 'extracting', 'detecting_licenses', 'ready', 'failed') and rs.updated_at < now() - interval '7 days'
    for update skip locked
  loop
    if r.resume_document_id is not null and exists (
      select 1 from resume_documents d where d.id = r.resume_document_id and d.kind = 'resubmission' and d.confirmed_at is null and d.candidate_id = r.candidate_id
    ) then
      insert into resume_storage_purge_queue (bucket, path)
        select 'resume-documents', pth from resume_documents d, unnest(array[d.original_storage_path, d.sanitized_render_path]) pth where d.id = r.resume_document_id and pth is not null;
      perform discard_resume_document(r.resume_document_id, r.candidate_id);
      docs := docs + 1;
    end if;
    update resume_resubmissions set status = 'expired', closed_at = now(), updated_at = now(), plan = null, plan_hash = null, base_fingerprint = null where id = r.id;
    n := n + 1;
  end loop;
  return jsonb_build_object('expired', n, 'documents_discarded', docs);
end $$;

revoke all on function expire_resume_resubmissions() from public, anon, authenticated;
grant execute on function expire_resume_resubmissions() to service_role;

select cron.schedule('expire-resume-resubmissions', '29 * * * *', 'select public.expire_resume_resubmissions()');
