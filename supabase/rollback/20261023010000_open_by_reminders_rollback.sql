-- Rollback of 20261023010000_open_by_reminders.sql (BS). Not run by anything automatic.
-- Drops the claim function and the two columns. Reminders already sent stay sent (the emails cannot be recalled); the columns' values are lost.
drop function if exists public.claim_open_by_reminders(integer, boolean, uuid[]);
alter table public.comparison_requests drop column if exists reminder_2d_sent_at;
alter table public.comparison_requests drop column if exists reminder_last_day_sent_at;
notify pgrst, 'reload schema';
