-- Rollback of 20261019030000_atid_export_prefs.sql. Run by hand, only on John's word.
-- Deploy the previous versions of the five session functions, set-atid-preferences (remove it) and the pages FIRST: they read these columns.
alter table public.candidates drop column if exists atid_export_json;
alter table public.candidates drop column if exists atid_export_pdf_hidden;
alter table public.candidates drop column if exists atid_export_pdf_line;
