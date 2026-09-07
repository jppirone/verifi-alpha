-- Positional fidelity + candidate-editable, staff-flagged needs_review entries.
--
-- Driven by a real live test against john.pirone@proton.me's actual resume (this session) that
-- surfaced three real bugs, reported and root-caused before any of this was written:
--
-- 1. Missing Skills section on the confirm screen: NOT an extraction or rendering bug. skill_items
--    populates correctly (confirmed live) and candidate.html already has real Skills-card render
--    code (commit 2406b3e). The live test ran against alpha.applitrust.com (GitHub Pages), which
--    was 3 commits behind this repo's local master at the time — the fix already existed, it just
--    hadn't shipped. No schema/prompt change needed for this one; the fix is deploying candidate.html
--    (see this session's own push), not anything in this migration.
--
-- 2. Certification fabrication: reproduced live and directly. Page 4 of the real document has a
--    real "Continuing Education" note — "55+ hours of AI & emerging technology certification
--    coursework, Coursiv, 2024-2025" — a narrative summary, not a discrete named credential (the 9
--    real, individually-named COURSIV certifications are fully itemized on page 1 already). The
--    model correctly captured this verbatim in needs_review (heading "Continuing Education") — but
--    ALSO, wrongly, synthesized a certification_items entry with a paraphrased name ("AI & emerging
--    technology certification coursework") that appears nowhere in the text as a standalone credential
--    line. Confirmed real, confirmed reproducible, confirmed a prompt gap (no rule against inventing
--    a category entry's identifying field from summary prose) — not a rendering or insert bug. Fixed
--    in the extraction prompts (see rasterize-pdf-page/extract-resume-fields/upload-resume), not here.
--
-- 3. Stale "possibly volunteer work" text: a hardcoded, content-specific example string in
--    candidate.html's needs_review card caption ("...an unpaid/volunteer role, or a section that
--    didn't match any category..."), not anything the extraction prompt generates. Fixed in
--    candidate.html, not here.
--
-- This migration covers the ARCHITECTURE CHANGE those bugs sit inside: positional fidelity (every
-- extracted unit remembers its place in the source document) and needs_review becoming multiple
-- real per-section entries instead of one blob, each independently flagged for staff without
-- blocking the candidate.

-- === Positional fidelity ===
-- One `position` integer per row, generic (not screen-specific) so the employer comparison view
-- (Item 15) can reuse the exact same data later, per explicit instruction. Nullable: existing rows
-- extracted before this migration have no real position on record (nothing upstream ever computed
-- one) — left null rather than backfilled with a guess, same convention already used for
-- candidate_freeform_sections.heading in the prior migration. A null position sorts last on any
-- screen that orders by it, which is the honest behavior for data this migration cannot retroactively
-- know.
--
-- The extraction prompt can only ever see ONE page at a time (rasterize-pdf-page's own architecture,
-- confirmed real: rendering multiple pages in one call is what caused the WORKER_RESOURCE_LIMIT
-- investigation earlier this session) — so the model can only assign a position LOCAL to the page
-- it's looking at (0, 1, 2... in that page's own top-to-bottom reading order, across every category,
-- since splitting content into typed JSON arrays already discards true interleaved document order
-- otherwise). upload-resume's mergeExtractions() converts each page's local position into a real
-- global one before this ever reaches the database: global_position = page_number * 1000 +
-- local_position (1000 is a generous per-page headroom — no real resume page has ever come close to
-- 1000 distinct extracted units). For the single-image path (extract-resume-fields, and
-- upload-resume's own vision-fallback branch) there is only ever one "page", so the model's local
-- position already IS the global one — no offset math needed or applied there.
--
-- skill_items is different: skills are one visual BLOCK on the confirm screen (all skills together),
-- not individually positioned units — the requirement is a position for "the skills block," not one
-- per skill. skill_items already has a `position` column, but that one means something else (each
-- skill's own order WITHIN the block, preserving the resume's own list order — see the prior
-- migration). Reusing that name for a different meaning here would be a real, confusing collision,
-- so this adds a second, distinctly-named column instead: `section_position`, set to the SAME value
-- on every skill_items row inserted from one extraction call — the position of the block as a whole,
-- not any individual skill.
alter table work_history_items add column if not exists position integer;
alter table education_items add column if not exists position integer;
alter table certification_items add column if not exists position integer;
alter table candidate_freeform_sections add column if not exists position integer;
alter table skill_items add column if not exists section_position integer;

-- === insert_resume_extraction: thread position through every table, needs_review stays untouched ===
-- Postgres has no ALTER FUNCTION for a changed parameter list — replacing the function changes its
-- signature, so the old 7-arg overload needs dropping explicitly first (same real gotcha as the
-- prior migration's own header already documented).
drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb);

create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,    -- array of {company,title,start_date,end_date,job_responsibilities,extraction_confidence,position}
  p_education jsonb,       -- array of {institution,degree,field_of_study,start_date,end_date,extraction_confidence,position}
  p_certifications jsonb,  -- array of {name,issuing_body,issue_date,expiration_date,extraction_confidence,position}
  p_skills jsonb,          -- array of plain strings, e.g. ["AI Prompt Engineering", "SaaS Onboarding & Implementation"]
  p_skills_position integer, -- position of the whole skills block; null if this extraction has no skills
  p_freeform jsonb         -- array of {section_type,heading,content,position}
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, start_date, end_date, job_responsibilities, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.company, r.title,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.job_responsibilities, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_work_history) as r(company text, title text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, start_date, end_date, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, start_date text, end_date text, extraction_confidence text, position integer);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, issue_date, expiration_date, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body,
         nullif(r.issue_date,'')::date, nullif(r.expiration_date,'')::date, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, issue_date text, expiration_date text, extraction_confidence text, position integer);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);
end;
$$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb) to service_role;

-- === Staff visibility for needs_review, without blocking the candidate (anti-gaming) ===
-- needs_review content is real, but it's the one place on this screen that is NOT validated against
-- the uploaded document by a defined schema (company/title/dates etc. all trace to a structured
-- field the way Job Responsibilities is the only free-typed field elsewhere in this build — see
-- candidate.html's own documented rule). needs_review is unstructured on purpose (it exists so real
-- content is never silently dropped or force-fit), which means it is also the one place a candidate
-- COULD try to slip in additional job-description-style claims under the cover of "content my resume
-- already had." Candidates keep full, unblocked edit access to it (see confirm-resume-data and
-- candidate.html) — this does not add any new validation gate or block on that path, and does not
-- touch or weaken the existing document-provenance rule for company/title/dates/etc. It only adds a
-- staff-side visibility flag, using the exact non-blocking-but-flagged pattern already live for
-- automated-check ambiguity: a verification_items row created with status = 'Needs Reconciliation'
-- (see staff.html's own header on that status — never shown to or implied to the candidate, staff
-- resolve it manually like every other queue item). confirm-resume-data does this insert itself,
-- unconditionally, for every needs_review row a candidate confirms — it is not gated by the
-- work_history/education/certifications opt-in checkboxes, because needs_review was never one of
-- those three categories and this isn't a verification submission; it's an internal review flag.
-- list-candidate-verification-items excludes this type from what a candidate's OWN status tab shows
-- (same staff-only trust boundary already used for internal_note and automated_check) so a candidate
-- never sees their own flagged-content notice framed as a "verification item pending review," which
-- it genuinely isn't.
--
-- No schema change is needed for this — verification_items.type and .status are both plain `text`
-- with no check constraint (confirmed live: `select conname, pg_get_constraintdef(oid) from
-- pg_constraint where conrelid = 'verification_items'::regclass` returns only the primary key and
-- the candidate_id foreign key). This comment is the durable record of that confirmation; the actual
-- inserts happen in confirm-resume-data.
