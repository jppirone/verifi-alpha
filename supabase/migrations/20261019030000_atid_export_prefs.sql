-- ATID stored export choices (AU), October 19, 2026. Builds on 20261019010000_atid.sql and 20261019020000_atid_employer_visible.sql.
--
-- John's decision (October 19, 2026): the three "include my ATID" export checkboxes stay on once a candidate turns them on, across tabs, screens, reloads,
-- sign-out and sign-in, and other browsers and devices. So they are stored on the candidate's account, OFF for everyone (existing accounts included):
--   atid_export_pdf_line    "Include my ATID as a line at the end of the PDF"
--   atid_export_pdf_hidden  "Include my ATID in the PDF's hidden information"
--   atid_export_json        "Include my ATID in the JSON file"
-- Each is boolean NOT NULL DEFAULT false, so every existing row becomes false and every new account starts false.
-- They only shape the candidate's own downloads. They are returned to the candidate's own session and to nobody else (never to an employer-facing path).
-- Changing them does not touch candidates.atid (the ATID triggers fire only when atid itself changes).
--
-- Rollback: supabase/rollback/20261019030000_atid_export_prefs_rollback.sql

alter table public.candidates add column if not exists atid_export_pdf_line boolean not null default false;
alter table public.candidates add column if not exists atid_export_pdf_hidden boolean not null default false;
alter table public.candidates add column if not exists atid_export_json boolean not null default false;
comment on column public.candidates.atid_export_pdf_line is 'The candidate chose to print their ATID as a line at the end of their own PDF. Default false.';
comment on column public.candidates.atid_export_pdf_hidden is 'The candidate chose to put their ATID in their own PDF hidden information (Keywords). Default false.';
comment on column public.candidates.atid_export_json is 'The candidate chose to include their ATID in their own JSON export. Default false.';
