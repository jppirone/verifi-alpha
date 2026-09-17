-- Item #3 (2026-09-17 live-demo scoping session): extend literal source-heading capture, which today
-- only exists for freeform rows (candidate_freeform_sections.heading, added 2026-09-06), to the three
-- structured categories -- work_history, education, certifications. This is the schema/persistence
-- half of a render-layer change (buildResumeLines in candidate.html) that groups and labels sections by
-- their real source heading instead of a fixed category taxonomy. Same trust tier as printed_header --
-- captured verbatim, additive only, does not change how content gets classified (mirrors the existing
-- freeform.heading rule's own stated intent).
alter table work_history_items add column if not exists heading text;
alter table education_items add column if not exists heading text;
alter table certification_items add column if not exists heading text;

-- insert_resume_extraction: same 11-param signature as the live 2026-09-12 version (printed_header) --
-- only the work_history/education/certifications jsonb_to_recordset column lists and their INSERTs
-- change, so no drop-and-recreate is needed (matches the pattern already used for certifications'
-- license_number, which extended the recordset shape without touching the signature).
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
  p_candidate_location text default null,
  p_printed_header text default null
) returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, location, start_date, end_date, job_responsibilities, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.company, r.title, nullif(r.location, ''),
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.job_responsibilities, r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_work_history) as r(company text, title text, location text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer, heading text);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, location, start_date, end_date, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study, nullif(r.location, ''),
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, location text, start_date text, end_date text, extraction_confidence text, position integer, heading text);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, license_number, issue_date, expiration_date, extraction_confidence, position, source_match, heading)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body, nullif(r.license_number, ''),
         nullif(r.issue_date,'')::date, nullif(r.expiration_date,'')::date, r.extraction_confidence, r.position,
         certification_source_match(r.name, p_ocr_text), nullif(r.heading, '')
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, license_number text, issue_date text, expiration_date text, extraction_confidence text, position integer, heading text);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);

  update resume_documents set candidate_location = nullif(p_candidate_location, ''), printed_header = nullif(p_printed_header, '') where id = p_resume_document_id;
end;
$function$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text) to service_role;
