-- Item 1 (2026-09-11 status-check session, CRITICAL): real sequence reproduced this week -- a
-- candidate on resumeConfirm saw content misclassified into needs_review and wanted to reject/
-- restart, but Confirm was the only available forward action on the screen. Forced to click
-- Confirm just to escape a bad state (not because the data was approved), they proceeded into the
-- rest of the flow with a "confirmation" that was never a real, willing approval -- undermining
-- what Confirm is supposed to mean everywhere else in the system too.
--
-- This is the real, atomic discard behind the new "reject this / start over" action: deletes a
-- resume_document and every row extracted from it, scoped to (resume_document_id, candidate_id) so
-- one candidate can never discard another's document even given a stale/tampered id. Modeled
-- directly on cleanup_expired_unconfirmed_resume_data's own proven delete order (children before
-- the parent row, since none of these FKs cascade -- confirmed live via information_schema when
-- that function was written) and extended to also cover skill_items, which didn't exist yet at
-- that function's original writing.
--
-- Storage objects (original_storage_path / sanitized_render_path) are deliberately NOT touched
-- here, same reasoning as that function's own note: a Postgres function can't reach Supabase
-- Storage directly. discard-resume-document (the Edge Function calling this) deletes those
-- best-effort after this RPC succeeds.
create or replace function discard_resume_document(p_resume_document_id uuid, p_candidate_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from resume_documents
    where id = p_resume_document_id and candidate_id = p_candidate_id
  ) then
    raise exception 'resume_document % does not belong to candidate %', p_resume_document_id, p_candidate_id;
  end if;

  delete from work_history_items where resume_document_id = p_resume_document_id;
  delete from education_items where resume_document_id = p_resume_document_id;
  delete from certification_items where resume_document_id = p_resume_document_id;
  delete from skill_items where resume_document_id = p_resume_document_id;
  delete from candidate_freeform_sections where resume_document_id = p_resume_document_id;
  delete from resume_documents where id = p_resume_document_id;
end;
$$;

grant execute on function discard_resume_document(uuid, uuid) to service_role;
