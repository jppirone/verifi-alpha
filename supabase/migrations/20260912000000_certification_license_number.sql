-- Item 7 (2026-09-12 live-testing session, confirmed live with direct evidence): certification_items
-- has no field for a license number, only name and issuing_body. A real test document ("Certifications/
-- Licenses: Plumber Lic # CFC1425829") had the section header correctly captured verbatim into
-- needs_review, but the license number itself had no structured field to land in.
--
-- license_number is a SIBLING field, not a replacement for name -- "Plumber" is a real, correct
-- informal trade name a candidate would realistically write; the fix is to give the license number its
-- own home, not to force name to hold a formal credential title it was never given. Required groundwork
-- for any future state-licensing-board lookup (the same DBPR/DORA automated checks already wired into
-- staff.html for exactly this kind of credential).
alter table certification_items add column if not exists license_number text;

-- === insert_resume_extraction: accept license_number for certifications (same signature — only the
-- certifications jsonb_to_recordset column list changes) ===
create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,
  p_education jsonb,
  p_certifications jsonb,
  p_skills jsonb,
  p_skills_position integer,
  p_freeform jsonb,
  p_ocr_text text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, location, start_date, end_date, job_responsibilities, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.company, r.title, nullif(r.location, ''),
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.job_responsibilities, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_work_history) as r(company text, title text, location text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, location, start_date, end_date, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study, nullif(r.location, ''),
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, location text, start_date text, end_date text, extraction_confidence text, position integer);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, license_number, issue_date, expiration_date, extraction_confidence, position, source_match)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body, nullif(r.license_number, ''),
         nullif(r.issue_date,'')::date, nullif(r.expiration_date,'')::date, r.extraction_confidence, r.position,
         certification_source_match(r.name, p_ocr_text)
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, license_number text, issue_date text, expiration_date text, extraction_confidence text, position integer);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);
end;
$$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text) to service_role;
