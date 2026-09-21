-- Account deletion log: a reactivated account must not keep looking like one that is waiting to be deleted (2026-09-21).
-- Found in the live test: an account whose billing had been cleared and that was then reactivated kept outcome 'billing_cleared' in
-- account_deletion_log, which reads like "pending deletion" to whoever checks the log for stuck accounts. Reactivation (deletion_scheduled_at
-- going from a date back to NULL) now marks the row 'reactivated' and drops the clearance (a later deactivation needs a fresh one anyway: the
-- clearance was already bound to the old deactivation timestamp, so this is bookkeeping, not a safety measure).
create or replace function trg_account_deletion_log_on_reactivation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update account_deletion_log set outcome = 'reactivated', billing_cleared_for = null, last_attempt_at = now()
   where candidate_id = new.id and outcome <> 'deleted';
  return new;
end $$;
drop trigger if exists account_deletion_log_on_reactivation on candidates;
create trigger account_deletion_log_on_reactivation after update of deletion_scheduled_at on candidates
  for each row when (new.deletion_scheduled_at is null and old.deletion_scheduled_at is not null)
  execute function trg_account_deletion_log_on_reactivation();
