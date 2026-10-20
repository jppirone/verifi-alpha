-- Rollback of 20261019040000_atid_upload_notice.sql. Run by hand, only on John's word.
-- Deploy the previous versions of upload-resume, get-resume-extraction and the page FIRST: they read this column.
alter table public.resume_documents drop constraint if exists resume_documents_atid_on_upload_check;
alter table public.resume_documents drop column if exists atid_on_upload;
