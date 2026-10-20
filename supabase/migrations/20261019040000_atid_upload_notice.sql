-- ATID on an uploaded resume (AU), October 19, 2026.
--
-- When an uploaded resume carries an ATID line, the line is left out of the content (as before) and the candidate gets one brief note or warning. To show it on the
-- confirm screen whenever the screen loads, the upload records ONE WORD on the resume document row:
--   'match'     the ATID line is the signed-in candidate's own
--   'mismatch'  anything else (another ATID, a made-up one, one with a bad check character, or any ATID on a first upload before an account exists)
--   null        no ATID line was on the upload
-- The ATID that was read off the resume is NEVER stored, logged or returned, and nothing is looked up for it: the only comparison is with the signed-in candidate's own ATID.
--
-- Rollback: supabase/rollback/20261019040000_atid_upload_notice_rollback.sql

alter table public.resume_documents add column if not exists atid_on_upload text;
alter table public.resume_documents drop constraint if exists resume_documents_atid_on_upload_check;
alter table public.resume_documents add constraint resume_documents_atid_on_upload_check check (atid_on_upload is null or atid_on_upload in ('match', 'mismatch'));
comment on column public.resume_documents.atid_on_upload is 'One word about an ATID line found on this upload: match (the candidate''s own) or mismatch (anything else). Never the ATID itself.';
