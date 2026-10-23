-- Open-by reminder emails for approved but unopened pay per use comparisons (BS), October 23, 2026.
--
-- A candidate approves a request; the employer then has until comparison_requests.snapshot_expires_at (about 7 days) to open it. This migration lets the sweep remind the employer
-- twice: when more than 24 and at most 48 hours remain ('2d'), and when more than 0 and at most 24 hours remain ('last_day'). Each reminder is recorded on the request the moment it is
-- handed out, so a request is never handed out twice for the same reminder, however often the sweep runs.
--
-- ADDITIVE: two nullable columns and one new function. No existing function, trigger, policy or row is changed. Nothing here sends anything; the edge function decides what to send (and
-- is off unless the edge secret REMINDER_EMAILS says otherwise).
--
-- Rules of claim_open_by_reminders (all must hold): status approved; access_method guest (pay per use); employer_user_id not null (the account still exists); first_delivered_at null
-- (not opened); snapshot_expires_at in the future. Both request kinds (resume_comparison and license_report) share the same open-by date, hold and price, so both are included.
-- A request first seen with 24 hours or less left gets only 'last_day' (the 2d reminder is skipped, never sent late); the 2d branch also requires that no last day reminder was ever handed out.
-- p_only_employer_user_ids: null means everyone; a list means only those employer users (an empty list means nobody).
-- p_peek true returns the rows and marks nothing and locks nothing. p_peek false marks the matching column with now() as it hands the rows out, under FOR UPDATE SKIP LOCKED.
-- Returns id, which, requester_email, requester_name and snapshot_expires_at, and nothing else (no candidate id, no kind).
--
-- Rollback: supabase/rollback/20261023010000_open_by_reminders_rollback.sql

alter table public.comparison_requests add column if not exists reminder_2d_sent_at timestamptz;
alter table public.comparison_requests add column if not exists reminder_last_day_sent_at timestamptz;
comment on column public.comparison_requests.reminder_2d_sent_at is 'When the 2 days left reminder was handed out for this request (null = not yet). Cleared by the sender only when the mail service definitely rejected the send.';
comment on column public.comparison_requests.reminder_last_day_sent_at is 'When the last day reminder was handed out for this request (null = not yet). Cleared by the sender only when the mail service definitely rejected the send.';

create or replace function public.claim_open_by_reminders(
  p_limit integer default 20,
  p_peek boolean default false,
  p_only_employer_user_ids uuid[] default null
)
returns table(id uuid, which text, requester_email text, requester_name text, snapshot_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_limit integer := greatest(coalesce(p_limit, 20), 0);
begin
  if coalesce(p_peek, false) then
    return query
      select r.id, case when r.snapshot_expires_at - now() <= interval '24 hours' then 'last_day' else '2d' end,
             r.requester_email, r.requester_name, r.snapshot_expires_at
        from public.comparison_requests r
       where r.status = 'approved'
         and r.access_method = 'guest'
         and r.employer_user_id is not null
         and r.first_delivered_at is null
         and r.snapshot_expires_at is not null
         and r.snapshot_expires_at > now()
         and ( (r.snapshot_expires_at - now() >  interval '24 hours' and r.snapshot_expires_at - now() <= interval '48 hours' and r.reminder_2d_sent_at is null and r.reminder_last_day_sent_at is null)
            or (r.snapshot_expires_at - now() <= interval '24 hours' and r.reminder_last_day_sent_at is null) )
         and (p_only_employer_user_ids is null or r.employer_user_id = any(p_only_employer_user_ids))
       order by r.snapshot_expires_at, r.id
       limit v_limit;
    return;
  end if;

  return query
  with due as (
    select r.id as rid,
           case when r.snapshot_expires_at - now() <= interval '24 hours' then 'last_day' else '2d' end as w
      from public.comparison_requests r
     where r.status = 'approved'
       and r.access_method = 'guest'
       and r.employer_user_id is not null
       and r.first_delivered_at is null
       and r.snapshot_expires_at is not null
       and r.snapshot_expires_at > now()
       and ( (r.snapshot_expires_at - now() >  interval '24 hours' and r.snapshot_expires_at - now() <= interval '48 hours' and r.reminder_2d_sent_at is null and r.reminder_last_day_sent_at is null)
          or (r.snapshot_expires_at - now() <= interval '24 hours' and r.reminder_last_day_sent_at is null) )
       and (p_only_employer_user_ids is null or r.employer_user_id = any(p_only_employer_user_ids))
     order by r.snapshot_expires_at, r.id
     limit v_limit
       for update of r skip locked
  ), marked as (
    update public.comparison_requests q
       set reminder_2d_sent_at       = case when d.w = '2d' then now() else q.reminder_2d_sent_at end,
           reminder_last_day_sent_at = case when d.w = 'last_day' then now() else q.reminder_last_day_sent_at end
      from due d
     where q.id = d.rid
    returning q.id as mid, d.w as mw, q.requester_email as me, q.requester_name as mn, q.snapshot_expires_at as md
  )
  select m.mid, m.mw, m.me, m.mn, m.md from marked m;
end $$;

revoke all on function public.claim_open_by_reminders(integer, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_open_by_reminders(integer, boolean, uuid[]) to service_role;

-- Let PostgREST see the new function and columns at once. (No earlier migration in this repository carries this line; it is harmless and only asks the API layer to reload its schema.)
notify pgrst, 'reload schema';
