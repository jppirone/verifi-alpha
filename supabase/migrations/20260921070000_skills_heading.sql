-- Skills section literal heading (2026-09-21).
--
-- Work history, education, certifications and the freeform sections have always stored the literal heading printed above them ("PROFESSIONAL EXPERIENCE",
-- "Core Competencies", ...) so the confirm screen, Content Manager and the generated PDF can reproduce the resume's own section titles. Skills was scoped out
-- of that first pass, so every screen hard-coded "Skills" whatever the resume actually said. This adds the column and lets the extraction RPC store it.
--
-- One heading per resume's skills block, copied onto every skill row of that block (the same way work-history rows under one heading each carry it), nullable:
-- every row extracted before this migration, and every resume whose skills have no visible heading, simply has none and the screens fall back to "Skills".
--
-- insert_resume_extraction gains ONE trailing parameter with a default (p_skills_heading), so callers that do not send it (the deployed functions until they are
-- redeployed) keep working unchanged. The old 11-argument signature is dropped in the same transaction so a call never sees two candidates for one name.
-- The function is SECURITY DEFINER and the edge functions call it with the service role only; the previous version was executable by PUBLIC (a default nobody
-- chose), which let the public API keys write extraction rows. The new one is granted to service_role alone.

alter table skill_items add column if not exists heading text;

drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text);

create or replace function insert_resume_extraction(
  p_resume_document_id uuid, p_candidate_id uuid, p_work_history jsonb, p_education jsonb, p_certifications jsonb, p_skills jsonb,
  p_skills_position integer, p_freeform jsonb, p_ocr_text text default null, p_candidate_location text default null, p_printed_header text default null,
  p_skills_heading text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, location, start_date, start_date_precision, end_date, end_date_precision, job_responsibilities, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.company, r.title, nullif(r.location, ''),
         parse_partial_date(r.start_date), nullif(partial_date_precision(r.start_date), 'present'),
         parse_partial_date(r.end_date), partial_date_precision(r.end_date),
         r.job_responsibilities, r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_work_history) as r(company text, title text, location text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer, heading text);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, location, start_date, start_date_precision, end_date, end_date_precision, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study, nullif(r.location, ''),
         parse_partial_date(r.start_date), nullif(partial_date_precision(r.start_date), 'present'),
         parse_partial_date(r.end_date), partial_date_precision(r.end_date),
         r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, location text, start_date text, end_date text, extraction_confidence text, position integer, heading text);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, license_number, issue_date, issue_date_precision, expiration_date, expiration_date_precision, extraction_confidence, position, source_match, heading)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body, nullif(r.license_number, ''),
         parse_partial_date(r.issue_date), nullif(partial_date_precision(r.issue_date), 'present'),
         parse_partial_date(r.expiration_date), nullif(partial_date_precision(r.expiration_date), 'present'),
         r.extraction_confidence, r.position,
         certification_source_match(r.name, p_ocr_text), nullif(r.heading, '')
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, license_number text, issue_date text, expiration_date text, extraction_confidence text, position integer, heading text);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position, heading)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position, nullif(btrim(p_skills_heading), '')
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);

  update resume_documents set candidate_location = nullif(p_candidate_location, ''), printed_header = nullif(p_printed_header, '') where id = p_resume_document_id;
end;
$function$;

revoke all on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text, text) to service_role;
