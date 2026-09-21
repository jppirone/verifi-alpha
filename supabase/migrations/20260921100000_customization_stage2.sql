-- Candidate customization, STAGE 2 (2026-09-21): constraint changes that go with rewiring the Customization / Content Manager / Views tabs.
-- (The two function bodies that changed in this stage, assemble_customized_resume and apply_customization_ops, are edited in place in
-- 20260921090000_customization_stage1.sql, which is idempotent and re-applied with them; see the DEFAULTS note at the top of that file.)
--
-- 1. A chosen summary version can be deleted by the candidate (delete-candidate-summary). The FK on selected_summary_id is ON DELETE SET NULL, and the
--    table-level check "summary_mode <> 'version' or selected_summary_id is not null" would then reject the delete itself. The assembler already treats
--    a 'version' choice whose row no longer exists as "use the default summary", so the check is dropped rather than making a summary undeletable.
-- 2. Summary text is candidate-authored content that flows into the reconciled output (the PDF and any future feed): capped at 4000 characters (name 100),
--    enforced by the create/update endpoints (which refuse, never truncate) and here as the last line of defense. Existing rows are all far below the cap.

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.candidate_customization'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%selected_summary_id IS NOT NULL%'
  loop
    execute format('alter table candidate_customization drop constraint %I', c.conname);
  end loop;
end $$;

alter table candidate_summary_versions drop constraint if exists candidate_summary_versions_content_len;
alter table candidate_summary_versions add constraint candidate_summary_versions_content_len check (char_length(content) <= 4000);
alter table candidate_summary_versions drop constraint if exists candidate_summary_versions_name_len;
alter table candidate_summary_versions add constraint candidate_summary_versions_name_len check (char_length(name) <= 100);
