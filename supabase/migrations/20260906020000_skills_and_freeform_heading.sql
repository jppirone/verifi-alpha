-- Two real, minimal additions to the resume pipeline, both driven by the same real investigation
-- (john.pirone@proton.me's actual resume, this session): a genuine, structured Skills destination,
-- and a verbatim heading capture on freeform rows.
--
-- 1. skill_items: a real home for a flat list of skill/competency/keyword terms (e.g. a "Core
-- Competencies" or "Skills" section) — the same shape as work_history_items/education_items/
-- certification_items (candidate_id + resume_document_id dual linkage during the pre-confirm
-- staging window, same lifecycle: inserted by insert_resume_extraction, backfilled to candidate_id
-- by backfill_resume_pipeline_candidate_id, edited+confirmed by confirm-resume-data, cleaned up by
-- cleanup_expired_unconfirmed_resume_data). Deliberately NOT capped at any item count here — the
-- old prototype "Skills" UI in candidate.html's Content Manager tab hard-capped at 15 fields purely
-- because it was seeded from a dev fixture with an artificial slice(0,15); this real resume alone
-- has 16 Core Competencies items, so a real cap here would silently reproduce the exact data-loss
-- bug this migration exists to fix. No `status` column: like candidate_freeform_sections, skills are
-- candidate-self-reported and never enter the staff verification_items queue (skills were never one
-- of the three real opt-in categories collected at signup, and nothing in this build adds a fourth).
create table skill_items (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id),
  resume_document_id uuid references resume_documents(id),
  skill_text text not null,
  position integer not null default 0,   -- preserves the resume's own order; not a ranking
  candidate_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

grant select, insert, update on table skill_items to service_role;

-- 2. heading: the freeform section's own literal heading text as printed on the page, captured
-- verbatim starting now for every new extraction. Existing rows have no heading on record (nothing
-- upstream ever captured it before this migration) — left null rather than backfilled with a guess.
-- Cheap now, and preserves real data for a future taxonomy analysis of what headers actually appear
-- across real resumes over time; that analysis itself is explicitly out of scope of this migration.
alter table candidate_freeform_sections add column if not exists heading text;

-- === insert_resume_extraction: add p_skills, and heading on freeform inserts ===
-- Postgres has no ALTER FUNCTION for adding a parameter — replacing the function changes its
-- signature, so the old 6-arg overload (uuid,uuid,jsonb,jsonb,jsonb,jsonb) needs dropping explicitly
-- or it lingers as dead, un-callable-by-name-alone overload noise (confirmed real by trying to
-- create or replace with an added arg: Postgres treats a changed parameter LIST as a distinct
-- function, not a replacement, unless the exact old signature is dropped first).
drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb);

create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,    -- array of {company,title,start_date,end_date,job_responsibilities,extraction_confidence}
  p_education jsonb,       -- array of {institution,degree,field_of_study,start_date,end_date,extraction_confidence}
  p_certifications jsonb,  -- array of {name,issuing_body,issue_date,expiration_date,extraction_confidence}
  p_skills jsonb,          -- array of plain strings, e.g. ["AI Prompt Engineering", "SaaS Onboarding & Implementation"]
  p_freeform jsonb         -- array of {section_type,heading,content}
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, start_date, end_date, job_responsibilities, extraction_confidence)
  select p_candidate_id, p_resume_document_id, r.company, r.title,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.job_responsibilities, r.extraction_confidence
  from jsonb_to_recordset(p_work_history) as r(company text, title text, start_date text, end_date text, job_responsibilities text, extraction_confidence text);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, start_date, end_date, extraction_confidence)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.extraction_confidence
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, start_date text, end_date text, extraction_confidence text);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, issue_date, expiration_date, extraction_confidence)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body,
         nullif(r.issue_date,'')::date, nullif(r.expiration_date,'')::date, r.extraction_confidence
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, issue_date text, expiration_date text, extraction_confidence text);

  -- p_skills is an array of plain strings (jsonb_array_elements_text), not objects — a flat list of
  -- terms has no other real field to carry, unlike the item tables above. `with ordinality` gives
  -- each element its real position in the resume's own order (0-based, matching skill_items.position's
  -- default), not an arbitrary insert order.
  insert into skill_items (candidate_id, resume_document_id, skill_text, position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text);
end;
$$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

-- === backfill_resume_pipeline_candidate_id: cover skill_items in the same cascade ===
create or replace function backfill_resume_pipeline_candidate_id(
  p_email_verification_id uuid,
  p_candidate_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update resume_documents set candidate_id = p_candidate_id
  where email_verification_id = p_email_verification_id and candidate_id is null;

  update work_history_items set candidate_id = p_candidate_id
  where resume_document_id in (select id from resume_documents where email_verification_id = p_email_verification_id)
    and candidate_id is null;

  update education_items set candidate_id = p_candidate_id
  where resume_document_id in (select id from resume_documents where email_verification_id = p_email_verification_id)
    and candidate_id is null;

  update certification_items set candidate_id = p_candidate_id
  where resume_document_id in (select id from resume_documents where email_verification_id = p_email_verification_id)
    and candidate_id is null;

  update skill_items set candidate_id = p_candidate_id
  where resume_document_id in (select id from resume_documents where email_verification_id = p_email_verification_id)
    and candidate_id is null;

  update candidate_freeform_sections set candidate_id = p_candidate_id
  where resume_document_id in (select id from resume_documents where email_verification_id = p_email_verification_id)
    and candidate_id is null;
end;
$$;

grant execute on function backfill_resume_pipeline_candidate_id(uuid, uuid) to service_role;

-- === cleanup_expired_unconfirmed_resume_data: cover skill_items in the same sweep ===
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

  delete from work_history_items where resume_document_id = any(v_ids);
  delete from education_items where resume_document_id = any(v_ids);
  delete from certification_items where resume_document_id = any(v_ids);
  delete from skill_items where resume_document_id = any(v_ids);
  delete from candidate_freeform_sections where resume_document_id = any(v_ids);
  delete from resume_documents where id = any(v_ids);
end;
$$;

grant execute on function cleanup_expired_unconfirmed_resume_data() to service_role;
