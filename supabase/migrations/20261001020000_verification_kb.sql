-- Verification Knowledge Base, Tier 0/1 (2026-10-01) -- Business Model Decision Log, Decision 39.
--
-- Scope, deliberately small: a plain EXACT-MATCH cache of "this employer exists in a state registry", written back by every successful
-- registry lookup. No AI entity resolution, no confidence scoring, no fuzzy matching -- those are later tiers and are justified (or ruled out)
-- by what kb_lookup_log records from day one.
--
--   kb_entities       one row per real registry entity, keyed on (registry_source_id, registry_entity_id). Carries last_verified_at and
--                     stale_after_days from the start (Decision 39: "every knowledge-base entry must carry a last-verified date and a
--                     staleness/re-verification policy from the start").
--   kb_entity_names   the exact-match lookup keys: (state, normalized name) -> entity. Many spellings can point at one entity
--                     ("ABC Inc" / "ABC, INC." / "Abc Inc."), so ABC Inc across 25 locations is one registry lookup, then 24 cache hits.
--   kb_lookup_log     every lookup: cache hit / miss / stale, what the registry said, how long it took. Logged from day one.
--
-- Access: service-role only (RLS on, no policies, every grant to anon / authenticated revoked), reached only through the
-- kb-verify-business edge function.

create table public.kb_entities (
  id uuid primary key default gen_random_uuid(),
  entity_kind text not null default 'employer' check (entity_kind in ('employer','school','licensing_authority','certifying_body')),
  state text not null check (state ~ '^[A-Z]{2}$'),
  registry_source_id text not null,                 -- e.g. 'co-sos'
  registry_entity_id text not null,                 -- the registry's own entity id
  name text not null,                               -- the registry's official name
  status text not null check (status in ('active','delinquent','inactive','dissolved','merged','pending','other')),
  status_raw text,
  entity_type text,
  registration_date date,
  source_dataset text not null,
  details jsonb not null default '{}'::jsonb,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  verification_count integer not null default 1,
  stale_after_days integer not null check (stale_after_days between 1 and 3650),
  last_outcome text not null default 'verified',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (registry_source_id, registry_entity_id)
);
create index kb_entities_state_idx on public.kb_entities (state);

create table public.kb_entity_names (
  state text not null check (state ~ '^[A-Z]{2}$'),
  name_key text not null,                           -- normalized exact-match key (see _shared/kb/kb.ts kbNameKey)
  entity_id uuid not null references public.kb_entities(id) on delete cascade,
  name_as_seen text not null,                       -- one example of how it was typed / filed
  created_at timestamptz not null default now(),
  primary key (state, name_key)
);
create index kb_entity_names_entity_idx on public.kb_entity_names (entity_id);

create table public.kb_lookup_log (
  id bigint generated always as identity primary key,
  looked_up_at timestamptz not null default now(),
  kind text not null default 'business',
  query_name text not null,
  query_name_key text not null,
  query_state text not null,
  caller text,                                      -- staff email, or 'service'
  cache_result text not null check (cache_result in ('hit','stale','miss','bypass','n/a')),
  final_outcome text not null check (final_outcome in ('verified','not_found','ambiguous','conflict','inconclusive','no_automated_source')),
  entity_id uuid references public.kb_entities(id) on delete set null,
  registry_queried boolean not null default false,
  registry_source_id text,
  registry_calls integer not null default 0,
  registry_ms integer,
  total_ms integer,
  status_seen text,
  detail jsonb not null default '{}'::jsonb
);
create index kb_lookup_log_time_idx on public.kb_lookup_log (looked_up_at desc);
create index kb_lookup_log_key_idx on public.kb_lookup_log (query_state, query_name_key);
create index kb_lookup_log_entity_idx on public.kb_lookup_log (entity_id);

-- Atomic write-back used by every successful registry verification: upsert the entity (bumping last_verified_at and verification_count),
-- then attach the exact-match name keys. A name key that already points at a DIFFERENT entity is never overwritten; it is reported back as
-- an alias conflict. SECURITY INVOKER on purpose (called with the service key only); execute is revoked from everyone else.
create or replace function public.kb_record_verified(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  e public.kb_entities;
  a jsonb;
  existing uuid;
  conflicts text[] := '{}';
begin
  insert into public.kb_entities (entity_kind, state, registry_source_id, registry_entity_id, name, status, status_raw, entity_type,
                                  registration_date, source_dataset, details, stale_after_days)
  values (coalesce(p->>'entity_kind', 'employer'), p->>'state', p->>'registry_source_id', p->>'registry_entity_id', p->>'name', p->>'status',
          p->>'status_raw', p->>'entity_type', nullif(p->>'registration_date', '')::date, p->>'source_dataset',
          coalesce(p->'details', '{}'::jsonb), (p->>'stale_after_days')::int)
  on conflict (registry_source_id, registry_entity_id) do update set
    name = excluded.name, status = excluded.status, status_raw = excluded.status_raw, entity_type = excluded.entity_type,
    registration_date = excluded.registration_date, source_dataset = excluded.source_dataset, details = excluded.details,
    stale_after_days = excluded.stale_after_days, last_verified_at = now(),
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

-- Hit-rate summary straight from the log: the evidence for (or against) building the AI-resolution tier later.
create or replace function public.kb_lookup_stats(p_since timestamptz default null) returns jsonb
language sql stable set search_path = public as $$
  with l as (select * from public.kb_lookup_log where p_since is null or looked_up_at >= p_since),
  eligible as (select * from l where cache_result in ('hit','stale','miss'))
  select jsonb_build_object(
    'lookups', (select count(*) from l),
    'cache_eligible', (select count(*) from eligible),
    'hits', (select count(*) from eligible where cache_result = 'hit'),
    'stale_refreshes', (select count(*) from eligible where cache_result = 'stale'),
    'misses', (select count(*) from eligible where cache_result = 'miss'),
    'hit_rate_pct', (select round(100.0 * count(*) filter (where cache_result = 'hit') / nullif(count(*), 0), 1) from eligible),
    'registry_calls_total', (select coalesce(sum(registry_calls), 0) from l),
    'registry_calls_avoided_by_hits', (select count(*) from eligible where cache_result = 'hit'),
    'by_outcome', (select coalesce(jsonb_object_agg(final_outcome, n), '{}'::jsonb) from (select final_outcome, count(*) n from l group by 1) x),
    'by_cache_result', (select coalesce(jsonb_object_agg(cache_result, n), '{}'::jsonb) from (select cache_result, count(*) n from l group by 1) x),
    'entities', (select count(*) from public.kb_entities),
    'name_keys', (select count(*) from public.kb_entity_names)
  );
$$;

create view public.kb_hit_rate_daily with (security_invoker = true) as
  select date_trunc('day', looked_up_at) as day,
         count(*) as lookups,
         count(*) filter (where cache_result = 'hit') as hits,
         count(*) filter (where cache_result = 'stale') as stale_refreshes,
         count(*) filter (where cache_result = 'miss') as misses,
         round(100.0 * count(*) filter (where cache_result = 'hit') / nullif(count(*) filter (where cache_result in ('hit','stale','miss')), 0), 1) as hit_rate_pct
  from public.kb_lookup_log group by 1 order by 1 desc;

alter table public.kb_entities enable row level security;
alter table public.kb_entity_names enable row level security;
alter table public.kb_lookup_log enable row level security;
revoke all on public.kb_entities, public.kb_entity_names, public.kb_lookup_log, public.kb_hit_rate_daily from public, anon, authenticated;
grant all on public.kb_entities, public.kb_entity_names, public.kb_lookup_log, public.kb_hit_rate_daily to service_role;
revoke execute on function public.kb_record_verified(jsonb) from public, anon, authenticated;
revoke execute on function public.kb_lookup_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.kb_record_verified(jsonb) to service_role;
grant execute on function public.kb_lookup_stats(timestamptz) to service_role;
