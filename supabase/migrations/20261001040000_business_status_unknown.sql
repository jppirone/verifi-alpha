-- Business status "unknown" (2026-10-01): Pennsylvania's registry list has no status column and keeps businesses that are no longer in operation, so
-- a row never supports "active". The two tables that store business status now accept 'unknown' (kb_entities, registry_entities).
alter table public.kb_entities drop constraint kb_entities_status_check;
alter table public.kb_entities add constraint kb_entities_status_check
  check (status in ('active','delinquent','inactive','dissolved','merged','pending','unknown','other'));
alter table public.registry_entities drop constraint registry_entities_status_check;
alter table public.registry_entities add constraint registry_entities_status_check
  check (status in ('active','delinquent','inactive','dissolved','merged','pending','unknown','other'));
