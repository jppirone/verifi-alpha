-- Real resume-contact-extraction (2026-09-23).
--
-- Real, confirmed bug (Priority 2/3 of the 2026-09-23 post-purge retest bug report, confirmed on
-- 4 of 5 reference documents): candidate.html's Profile Info "Printed Number"/"Printed Email"
-- fields never had anything real to pre-fill from. There was NO structured "phone/email as
-- printed on the resume" field anywhere in the extraction pipeline -- only candidate_location
-- (already structured) and printed_header (the entire personal-info block as one verbatim text
-- blob, never parsed back apart). seedContactFromAccount's own 2026-09-23-earlier-today header
-- comment documents this explicitly: printed fields were deliberately reverted to NEVER seed from
-- account/registration data, "otherwise start empty ... until real resume-contact-extraction is
-- built as its own separate feature (not done as of this fix)". This migration is that feature's
-- storage layer.
--
-- candidate_phone / candidate_email live on resume_documents, the same place candidate_location
-- and printed_header already live -- "what this specific resume printed", not the candidate's
-- account/registration phone or email (candidates.phone / candidates.email), a different concept
-- entirely and already used for the separate "Verified Number" field on this same screen.

alter table resume_documents add column if not exists candidate_phone text;
alter table resume_documents add column if not exists candidate_email text;

create or replace function insert_resume_extraction(
  p_resume_document_id uuid, p_candidate_id uuid, p_work_history jsonb, p_education jsonb,
  p_certifications jsonb, p_skills jsonb, p_skills_position integer, p_freeform jsonb,
  p_ocr_text text default null, p_candidate_location text default null, p_printed_header text default null,
  p_skills_heading text default null, p_candidate_phone text default null, p_candidate_email text default null
)
returns void language plpgsql security definer set search_path to 'public' as $$
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

  update resume_documents set candidate_location = nullif(p_candidate_location, ''), printed_header = nullif(p_printed_header, ''),
    candidate_phone = nullif(p_candidate_phone, ''), candidate_email = nullif(p_candidate_email, '')
  where id = p_resume_document_id;
end;
$$;
