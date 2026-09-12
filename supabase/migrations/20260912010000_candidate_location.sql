-- Item 19 (2026-09-12 live-testing session): a real, confirmed gap surfaced investigating Item 15 --
-- there is no field anywhere in the system (extraction schema, candidate profile, account) that
-- captures a candidate's own personal location as printed on their resume (e.g. "Sebastian FL",
-- right next to their name/contact line). work_history.location and education.location are real and
-- distinct -- an employer's or institution's location, never the candidate's own. This is genuinely
-- new data, not a rendering bug: nothing was ever extracting it, so nowhere was there anything to
-- render.
--
-- Lives on resume_documents (a document-level scalar, same conceptual role as ocr_raw_text or
-- extraction_status) rather than a new item table, since it's one value per document, not a list.
-- candidate_confirmed intentionally omitted -- confirm-resume-data's own update (see its header)
-- writes this directly alongside the resume_document row it already has open, the same trust
-- category as every other candidate-stated/document-extracted field on this table.
alter table resume_documents add column if not exists candidate_location text;

-- === insert_resume_extraction: accept candidate_location, one new trailing param ===
-- A genuinely new parameter changes the function's argument-type signature, so `create or replace`
-- alone would leave the OLD 9-arg version sitting alongside this new 10-arg one as a separate
-- overload (Postgres identifies functions by their full type signature, not just name) rather than
-- truly replacing it. Dropped explicitly first so exactly one version exists after this migration —
-- no ambiguity for a caller that ever gets this wrong, no dead overload left behind.
drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text);

create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,
  p_education jsonb,
  p_certifications jsonb,
  p_skills jsonb,
  p_skills_position integer,
  p_freeform jsonb,
  p_ocr_text text default null,
  p_candidate_location text default null
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

  update resume_documents set candidate_location = nullif(p_candidate_location, '') where id = p_resume_document_id;
end;
$$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text) to service_role;
