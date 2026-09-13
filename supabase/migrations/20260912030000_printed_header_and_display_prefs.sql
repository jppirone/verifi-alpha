-- Item 6/7 (2026-09-12 live-testing session, follow-up build): two pieces of groundwork.
--
-- 1. printed_header: the candidate's full personal-info header (name, with any middle initial,
--    suffix, or qualifier exactly as printed; contact info; location) captured as ONE verbatim
--    blob, never parsed into parts. Same trust category as candidate_location (Item 19) -- a
--    document-extracted field, shown read-only on resumeConfirm, never edited there. Distinct from
--    candidate_location: this is the whole header as literally printed, kept forever exactly as
--    captured; candidate_location was a structured, resumeConfirm-editable field whose own
--    resumeConfirm UI is being retired in this same change now that this verbatim blob covers the
--    same ground and the "account information" header path (below) sources location from the
--    candidate's own Personal Info instead.
--
-- 2. header_display_mode / personal_location: real, durable, per-candidate preferences -- unlike
--    every other Profile Info field today (first/last name, printed phone/email, notification
--    prefs), which are client-state-only and never actually persisted (confirmed live: saveActive()
--    for the profile tab only copies React state, no backend call at all). That gap is real but out
--    of scope here; these two fields specifically need to survive a refresh/new session because they
--    govern what a real downstream document or partner delivery actually contains, so they get real
--    columns and a real save path (see save-header-preferences).
--    header_display_mode: 'printed' (default, per instruction) reproduces the verbatim printed_header
--    blob as-is; 'account' composes a clean header from structured fields (first/last name, verified
--    phone/email, and personal_location if set) with no suffix/qualifier support.
--    personal_location: candidate-editable, account-level (not tied to any one resume_document) --
--    the location used ONLY by the 'account' composition path.
alter table resume_documents add column if not exists printed_header text;

alter table candidates add column if not exists header_display_mode text not null default 'printed';
alter table candidates add column if not exists personal_location text;

alter table candidates drop constraint if exists candidates_header_display_mode_check;
alter table candidates add constraint candidates_header_display_mode_check check (header_display_mode in ('printed', 'account'));

-- insert_resume_extraction: add p_printed_header (11th param). Exact prior body reproduced via
-- pg_get_functiondef against the live deployed function (Item 19's own version) -- only the new
-- parameter and the final UPDATE's column list changed, nothing else touched.
drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text);

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

  update resume_documents set candidate_location = nullif(p_candidate_location, ''), printed_header = nullif(p_printed_header, '') where id = p_resume_document_id;
end;
$function$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text) to service_role;
