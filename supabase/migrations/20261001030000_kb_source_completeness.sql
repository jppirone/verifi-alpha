-- KB source completeness tag (2026-10-01).
--
-- Not every registry tells the whole story. Colorado and Connecticut publish every entity with a status (active, dissolved, merged, ...), so
-- "not found" there means "never registered under that name". New York and Oregon publish ACTIVE entities only (verified: 240 entities New York
-- records as dissolved are absent from its active list; 1.5% of Oregon's recent registrations have already dropped off its active list), so for
-- them "not found" can also mean "registered once, since dissolved / merged / withdrawn". A later resolution step must be able to tell the two
-- kinds of source apart, so every cached entity carries the completeness of the source that verified it:
--   full_history             the registry lists every entity with a status                          (CO, CT)
--   active_only              the registry lists only entities that are currently active             (NY, OR)
--   registrations_unflagged  the registry lists registrations with no status and does not remove defunct businesses (PA; not enabled)
-- The lookup log carries it too, because the same distinction decides what a miss means.

alter table public.kb_entities
  add column source_completeness text not null default 'full_history'
  check (source_completeness in ('full_history', 'active_only', 'registrations_unflagged'));

alter table public.kb_lookup_log
  add column source_completeness text
  check (source_completeness is null or source_completeness in ('full_history', 'active_only', 'registrations_unflagged'));

-- Same atomic write-back as before, now also recording the completeness of the verifying source (inserted and refreshed with the entity).
create or replace function public.kb_record_verified(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  e public.kb_entities;
  a jsonb;
  existing uuid;
  conflicts text[] := '{}';
begin
  insert into public.kb_entities (entity_kind, state, registry_source_id, registry_entity_id, name, status, status_raw, entity_type,
                                  registration_date, source_dataset, details, stale_after_days, source_completeness)
  values (coalesce(p->>'entity_kind', 'employer'), p->>'state', p->>'registry_source_id', p->>'registry_entity_id', p->>'name', p->>'status',
          p->>'status_raw', p->>'entity_type', nullif(p->>'registration_date', '')::date, p->>'source_dataset',
          coalesce(p->'details', '{}'::jsonb), (p->>'stale_after_days')::int, coalesce(p->>'source_completeness', 'full_history'))
  on conflict (registry_source_id, registry_entity_id) do update set
    name = excluded.name, status = excluded.status, status_raw = excluded.status_raw, entity_type = excluded.entity_type,
    registration_date = excluded.registration_date, source_dataset = excluded.source_dataset, details = excluded.details,
    stale_after_days = excluded.stale_after_days, source_completeness = excluded.source_completeness, last_verified_at = now(),
    verification_count = public.kb_entities.verification_count + 1, last_outcome = 'verified', updated_at = now()
  returning * into e;

  for a in select * from jsonb_array_elements(coalesce(p->'alias_keys', '[]'::jsonb)) loop
    insert into public.kb_entity_names (state, name_key, entity_id, name_as_seen)
    values (e.state, a->>'key', e.id, coalesce(a->>'seen', a->>'key'))
    on conflict (state, name_key) do nothing;
    select entity_id into existing from public.kb_entity_names where state = e.state and name_key = a->>'key';
    if existing <> e.id then conflicts := conflicts || (a->>'key'); end if;
  end loop;

  return jsonb_build_object('entity', to_jsonb(e), 'alias_conflicts', to_jsonb(conflicts));
end $$;

-- Rows verified by the active-only sources before this column existed (none yet) would be tagged here; the default covers Colorado / Connecticut.
update public.kb_entities set source_completeness = 'active_only' where registry_source_id in ('ny-dos', 'or-sos');

revoke execute on function public.kb_record_verified(jsonb) from public, anon, authenticated;
grant execute on function public.kb_record_verified(jsonb) to service_role;
