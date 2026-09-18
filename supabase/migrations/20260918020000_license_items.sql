-- license_items: real, automatically-verifiable state licenses, separate from certification_items.
-- A license detected by the additive detect-license-mentions pass (resume path) or entered on the
-- license-only signup form lands here; verify-license (shared state-agnostic module, Florida/DBPR
-- adapter first) writes the outcome back onto the same row.
--
-- state is nullable on purpose: the candidate may decline to supply it. Without it no automated
-- check can run and the row simply stays unverified (verification_outcome null / 'unverified').
--
-- linked_certification_id: a license the extraction pass already put in certification_items (with a
-- license_number) is linked, not dropped, so it stays verifiable and shows once in the UI.
create table if not exists license_items (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id),
  resume_document_id uuid references resume_documents(id),
  source text not null default 'resume',            -- 'resume' | 'license_only'
  linked_certification_id uuid references certification_items(id),
  source_text text,                                  -- verbatim text the detector saw
  license_number text,
  holder_name_guess text,
  state text,                                        -- 2-letter code, only from a real textual signal or the candidate
  state_evidence text,                               -- verbatim snippet that named the state (null if candidate-supplied)
  state_source text,                                 -- 'detected' | 'candidate'
  license_name text,
  issuing_body text,
  trade_soc_code text,
  issue_date date,
  expiration_date date,
  confidence numeric,
  candidate_confirmed boolean not null default false,
  verification_outcome text,                         -- verified | ambiguous | unsupported_jurisdiction | not_found | error
  verification_reason text,
  verification_detail jsonb,
  verification_attempted_at timestamptz,
  verified_at timestamptz,
  verification_source text,                          -- e.g. 'fl_dbpr'
  queue_item_id text,                                -- verification_items.id created for this license, if any
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists license_items_candidate_idx on license_items (candidate_id);
create index if not exists license_items_resume_document_idx on license_items (resume_document_id);

grant select, insert, update, delete on table license_items to service_role;

alter table resume_documents add column if not exists license_detection_status text;  -- null | running | done | failed
alter table resume_documents add column if not exists license_detected_at timestamptz;

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

  delete from license_items where resume_document_id = p_resume_document_id;
  delete from work_history_items where resume_document_id = p_resume_document_id;
  delete from education_items where resume_document_id = p_resume_document_id;
  delete from certification_items where resume_document_id = p_resume_document_id;
  delete from skill_items where resume_document_id = p_resume_document_id;
  delete from candidate_freeform_sections where resume_document_id = p_resume_document_id;
  delete from resume_documents where id = p_resume_document_id;
end;
$$;

grant execute on function discard_resume_document(uuid, uuid) to service_role;

create or replace function cleanup_expired_unconfirmed_resume_data() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select array_agg(rd.id) into v_ids
  from resume_documents rd
  join email_verifications ev on ev.id = rd.email_verification_id
  where rd.candidate_id is null and ev.confirmed_at is null and ev.expires_at < now();

  if v_ids is null then return; end if;

  delete from license_items where resume_document_id = any(v_ids);
  delete from work_history_items where resume_document_id = any(v_ids);
  delete from education_items where resume_document_id = any(v_ids);
  delete from certification_items where resume_document_id = any(v_ids);
  delete from skill_items where resume_document_id = any(v_ids);
  delete from candidate_freeform_sections where resume_document_id = any(v_ids);
  delete from resume_documents where id = any(v_ids);
end;
$$;

grant execute on function cleanup_expired_unconfirmed_resume_data() to service_role;
