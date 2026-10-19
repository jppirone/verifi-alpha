-- Rollback of 20261019010000_atid.sql. Run by hand, only on John's word.
-- WARNING: dropping atid_registry throws away the record of which ATIDs were ever issued, so a later re-build could issue an
-- old (retired) ATID again. Keep the table (skip the last statement) if the ATIDs have been printed anywhere.
drop trigger if exists candidates_atid_insert on public.candidates;
drop trigger if exists candidates_atid_no_change on public.candidates;
drop trigger if exists candidates_atid_retire on public.candidates;
alter table public.candidates drop constraint if exists candidates_atid_format;
alter table public.candidates drop constraint if exists candidates_atid_key;
alter table public.candidates drop column if exists atid;
drop function if exists public.trg_candidates_atid_insert();
drop function if exists public.trg_candidates_atid_no_change();
drop function if exists public.trg_candidates_atid_retire();
drop function if exists public.atid_issue_new();
drop function if exists public.atid_generate_stored();
drop function if exists public.atid_display(text);
drop function if exists public.atid_is_stored(text);
drop function if exists public.atid_valid_code(text);
drop function if exists public.atid_check_char(text);
drop function if exists public.atid_prefix();
-- the registry is the permanent record; remove it ONLY if nothing was ever printed:
-- drop table if exists public.atid_registry;
