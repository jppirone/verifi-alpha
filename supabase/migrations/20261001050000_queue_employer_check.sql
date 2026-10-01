-- Verification queue x Knowledge Base (2026-10-01): the employer check and operating-status confirmation live ON the queue item.
--   employer_check                      the KB result for the employer (status, entity, message, ...) as returned at check time; null = never checked
--   operating_status                    active_per_registry | not_active | unknown (what the registry lets us say about the employer operating)
--   operating_confirmation_required     true when the registry publishes no status at all (Pennsylvania): routes the item to staff confirmation of OPERATING
--                                       STATUS, separately from existence (existence stays resolved automatically)
--   operating_resolution / _at / _by    staff's answer: operating | not_operating | undetermined. update-verification-item refuses status "Confirmed" on an
--                                       item with operating_confirmation_required = true until this is set.
-- Staff-only: list-candidate-verification-items selects explicit columns and never returns these.
alter table public.verification_items
  add column employer_check jsonb,
  add column operating_status text check (operating_status is null or operating_status in ('active_per_registry', 'not_active', 'unknown')),
  add column operating_confirmation_required boolean not null default false,
  add column operating_resolution text check (operating_resolution is null or operating_resolution in ('operating', 'not_operating', 'undetermined')),
  add column operating_resolved_at timestamptz,
  add column operating_resolved_by text;

create index verification_items_operating_pending_idx on public.verification_items (id)
  where operating_confirmation_required and operating_resolution is null;
