-- ATID (Applitrust ID), first build. October 19, 2026.
--
-- Every candidate account gets ONE permanent public identifier: ATID-XXXX-XXXX-XXXX.
--   stored form    ATID + 11 random characters + 1 check character      (16 characters, upper case)
--   displayed form ATID-XXXX-XXXX-XXXX                                   (public.atid_display)
-- The characters come from the 32 character alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ (no I, L, O, U) and the check character is
-- Luhn mod 32 over the 11 random characters, the same scheme as the KIO ID in the other project (copied, not shared: the two
-- projects are separate databases). The stored form and the displayed form are defined ONLY in the functions below; the
-- shared test vector tools/resume/atid-vectors.json is run against these functions (SQL) and against supabase/functions/_shared/resume-atid.ts (JS).
--
-- RULES (John's decisions, October 19, 2026)
--   * Every account has one, license_only included.
--   * A person who deletes the account and registers again gets a NEW ATID. A retired ATID is never issued again:
--     atid_registry keeps the row forever, with retired_at set when the account is deleted.
--   * The ATID is a POINTER ONLY. It never authenticates anyone and never unlocks a lookup. Nothing here reads it for access.
--   * atid_registry holds NO personal data: no candidate id, no email, no foreign key, no cascade. It cannot be joined back to a person.
--   * candidates.verification_id is NOT touched by this migration (it is a credential).
--
-- WHAT IT DOES
--   1. atid_registry (service role only; row level security on, all privileges revoked, only the trigger functions write it).
--   2. The pure functions atid_prefix, atid_check_char, atid_valid_code, atid_is_stored, atid_display, and atid_generate_stored.
--   3. candidates.atid (nullable first), three triggers, a backfill of every existing row, then UNIQUE, NOT NULL and a CHECK on the format.
--        BEFORE INSERT : any supplied atid is IGNORED; a new one is generated and registered in the same transaction (a failed insert,
--                        for example a duplicate email, rolls the registration back with it). Up to 10 tries on a collision.
--        BEFORE UPDATE : a change of an existing atid is refused (setting it once, from null, is how the backfill works).
--        BEFORE DELETE : the registry row gets retired_at. delete_candidate_account needs no edit.
--
-- NOT DONE HERE ON PURPOSE: assemble_customized_resume is NOT changed. Its output feeds the employer's comparison document
-- (candidate-comparison-requests, action assemble_plain_document, returns the whole assembled resume to the employer page), so an
-- atid in it would reach employers. get-customization adds the candidate's own atid to ITS response instead.
--
-- Rollback: supabase/rollback/20261019010000_atid_rollback.sql (outside the migrations folder on purpose, so the CLI never applies it).

-- ---------------------------------------------------------------- 1. the registry
create table if not exists public.atid_registry (
  atid        text primary key,
  issued_at   timestamptz not null default now(),
  retired_at  timestamptz
);
alter table public.atid_registry enable row level security;
revoke all on public.atid_registry from public, anon, authenticated;
comment on table public.atid_registry is 'Every ATID ever issued. No personal data, no candidate id, no foreign key. Rows are never deleted; retired_at is set when the account is deleted, and a retired ATID is never issued again.';

-- ---------------------------------------------------------------- 2. the pure functions
create or replace function public.atid_prefix() returns text language sql immutable parallel safe set search_path to '' as $f$ select 'ATID'::text $f$;

-- the check character of an 11 character body (null when the body is not 11 characters of the alphabet)
create or replace function public.atid_check_char(p_body text) returns text language plpgsql immutable parallel safe set search_path to '' as $f$
declare
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_factor int := 2; v_sum int := 0; v_add int; v_cp int; i int;
begin
  if p_body is null or p_body !~ '^[0-9A-HJKMNP-TV-Z]{11}$' then return null; end if;
  for i in reverse 11..1 loop
    v_cp := strpos(a, substr(p_body, i, 1)) - 1;
    v_add := v_factor * v_cp;
    v_factor := case when v_factor = 2 then 1 else 2 end;
    v_add := (v_add / 32) + (v_add % 32);
    v_sum := v_sum + v_add;
  end loop;
  return substr(a, ((32 - (v_sum % 32)) % 32) + 1, 1);
end
$f$;

-- is this 12 character code (body + check character) valid?
create or replace function public.atid_valid_code(p_code text) returns boolean language plpgsql immutable parallel safe set search_path to '' as $f$
declare
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_factor int := 1; v_sum int := 0; v_add int; v_cp int; i int;
begin
  if p_code is null or p_code !~ '^[0-9A-HJKMNP-TV-Z]{12}$' then return false; end if;
  for i in reverse 12..1 loop
    v_cp := strpos(a, substr(p_code, i, 1)) - 1;
    v_add := v_factor * v_cp;
    v_factor := case when v_factor = 2 then 1 else 2 end;
    v_add := (v_add / 32) + (v_add % 32);
    v_sum := v_sum + v_add;
  end loop;
  return v_sum % 32 = 0;
end
$f$;

-- the STORED form: ATID + 12 characters, and the check character fits
create or replace function public.atid_is_stored(p_atid text) returns boolean language sql immutable parallel safe set search_path to '' as $f$
  select p_atid is not null
     and p_atid ~ ('^' || public.atid_prefix() || '[0-9A-HJKMNP-TV-Z]{12}$')
     and public.atid_valid_code(substr(p_atid, char_length(public.atid_prefix()) + 1))
$f$;

-- the DISPLAYED form ATID-XXXX-XXXX-XXXX; anything that is not a stored ATID comes back as it is
create or replace function public.atid_display(p_atid text) returns text language sql immutable parallel safe set search_path to '' as $f$
  select case
    when public.atid_is_stored(p_atid)
      then public.atid_prefix() || '-' || substr(p_atid, 5, 4) || '-' || substr(p_atid, 9, 4) || '-' || substr(p_atid, 13, 4)
    else p_atid
  end
$f$;

-- one candidate ATID, not registered yet: the prefix, 11 random characters (55 of the 60 random bits of a v4 uuid, fully random from position 18), the check character
create or replace function public.atid_generate_stored() returns text language plpgsql volatile set search_path to '' as $f$
declare
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_hex text; v_n bigint; v_body text := ''; i int;
begin
  v_hex := substr(replace(gen_random_uuid()::text, '-', ''), 18, 15);
  v_n := ('x' || v_hex)::bit(60)::bigint;
  for i in 0..10 loop
    v_body := v_body || substr(a, ((v_n >> (55 - 5 * i)) & 31)::int + 1, 1);
  end loop;
  return public.atid_prefix() || v_body || public.atid_check_char(v_body);
end
$f$;

-- a new ATID that was never issued before: generate, then register in the same statement (a conflict with ANY registry row,
-- retired ones included, is a collision); up to 10 tries
create or replace function public.atid_issue_new() returns text language plpgsql security definer set search_path to '' as $f$
declare v text; v_tries int := 0; v_n int;
begin
  loop
    v := public.atid_generate_stored();
    insert into public.atid_registry (atid) values (v) on conflict (atid) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then return v; end if;
    v_tries := v_tries + 1;
    if v_tries >= 10 then raise exception 'atid_issue_new: no free ATID after 10 tries'; end if;
  end loop;
end
$f$;
revoke all on function public.atid_issue_new() from public, anon, authenticated;
grant execute on function public.atid_issue_new() to service_role;

-- ---------------------------------------------------------------- 3. the column and the triggers
alter table public.candidates add column if not exists atid text;

create or replace function public.trg_candidates_atid_insert() returns trigger language plpgsql security definer set search_path to '' as $f$
begin
  new.atid := public.atid_issue_new();   -- a supplied value is ignored on purpose
  return new;
end
$f$;

create or replace function public.trg_candidates_atid_no_change() returns trigger language plpgsql set search_path to '' as $f$
begin
  -- setting it once, from null, is allowed (the backfill); every other change is refused
  if old.atid is not null and new.atid is distinct from old.atid then
    raise exception 'candidates.atid is permanent and cannot be changed' using errcode = '42501';
  end if;
  return new;
end
$f$;

create or replace function public.trg_candidates_atid_retire() returns trigger language plpgsql security definer set search_path to '' as $f$
begin
  if old.atid is not null then
    update public.atid_registry set retired_at = coalesce(retired_at, now()) where atid = old.atid;
  end if;
  return old;
end
$f$;

drop trigger if exists candidates_atid_insert on public.candidates;
create trigger candidates_atid_insert before insert on public.candidates
  for each row execute function public.trg_candidates_atid_insert();

drop trigger if exists candidates_atid_no_change on public.candidates;
create trigger candidates_atid_no_change before update on public.candidates
  for each row when (old.atid is distinct from new.atid) execute function public.trg_candidates_atid_no_change();

drop trigger if exists candidates_atid_retire on public.candidates;
create trigger candidates_atid_retire before delete on public.candidates
  for each row execute function public.trg_candidates_atid_retire();

-- ---------------------------------------------------------------- 4. backfill every existing row (seed and test rows and the rows with no verification_id included), then the constraints
do $backfill$
declare r record;
begin
  for r in select id from public.candidates where atid is null order by id loop
    update public.candidates set atid = public.atid_issue_new() where id = r.id;
  end loop;
end
$backfill$;

alter table public.candidates alter column atid set not null;
alter table public.candidates add constraint candidates_atid_key unique (atid);
alter table public.candidates add constraint candidates_atid_format check (public.atid_is_stored(atid));

-- the proof inside the migration: no row without a valid, registered ATID (the migration stops if one is found)
do $proof$
declare v_bad int;
begin
  select count(*) into v_bad from public.candidates c where not public.atid_is_stored(c.atid) or not exists (select 1 from public.atid_registry r where r.atid = c.atid);
  if v_bad > 0 then raise exception 'ATID migration: % candidates without a valid registered ATID', v_bad; end if;
end
$proof$;
