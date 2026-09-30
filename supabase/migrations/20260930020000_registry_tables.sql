-- State business-registry and professional-license integrations, Stage 1 (2026-09-30).
--
-- Socrata-backed sources (CO/NY/CT/OR/PA business registries; CO/CT/IL/WA licenses) are queried LIVE and store nothing.
-- These tables exist only for FILE-BASED sources that cannot be queried live: Florida Sunbiz (fixed-width flat file), California
-- DCA (monthly tab-delimited files), and the request-based Michigan / Delaware rosters. Rows are stored in the SAME common
-- shape the live adapters return (supabase/functions/_shared/registry/schema.ts), so one lookup path serves both kinds.
--
-- Storage: the project is on the free plan (500 MB database; hitting it makes the project READ-ONLY, which would take the
-- whole app down). Ingest is therefore bounded per source on purpose (see registry-ingest and docs/registry-stage1-report).
--
-- Access: service-role only. RLS is enabled with NO policies and every grant to anon / authenticated is revoked; these
-- tables are reached only through the registry-lookup / registry-ingest edge functions, which authenticate staff or service.

create table public.registry_entities (
  source_id text not null,                 -- e.g. 'fl-sunbiz'
  entity_id text not null,                 -- the registry's own entity / document number
  entity_name text not null,
  name_key text not null,                  -- upper(name), whitespace collapsed: the search key
  status text not null check (status in ('active','delinquent','inactive','dissolved','merged','pending','other')),
  status_raw text,
  registration_date date,
  entity_type text,
  state text not null check (state ~ '^[A-Z]{2}$'),
  source_dataset text not null,
  details jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now(),
  primary key (source_id, entity_id)
);
create index registry_entities_name_key_idx on public.registry_entities (source_id, name_key text_pattern_ops);

create table public.license_records (
  source_id text not null,                 -- e.g. 'ca-dca'
  record_key text not null,                -- unique within the source (license numbers alone are not: per-board / per-type)
  license_holder_name text not null,
  holder_kind text not null check (holder_kind in ('individual','business','unknown')),
  name_key text not null,
  last_key text,                           -- individuals: upper(last name) / upper(first name), for first+last lookups
  first_key text,
  license_number text not null,
  license_type text,
  status text not null check (status in ('active','expired','revoked','suspended','inactive','pending','other')),
  status_raw text,
  issue_date date,
  expiration_date date,
  state text not null check (state ~ '^[A-Z]{2}$'),
  board_agency text not null,
  source text not null,
  details jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now(),
  primary key (source_id, record_key)
);
create index license_records_name_key_idx on public.license_records (source_id, name_key text_pattern_ops);
create index license_records_person_idx on public.license_records (source_id, last_key, first_key);
create index license_records_number_idx on public.license_records (source_id, license_number);

-- Provenance for every ingest: which file, when, how many rows landed / were rejected. A monthly or manual refresh is one run.
create table public.registry_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  kind text not null check (kind in ('business','license')),
  file_name text,
  file_sha256 text,
  note text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_upserted integer not null default 0,
  rows_rejected integer not null default 0,
  rows_pruned integer not null default 0,
  status text not null default 'running' check (status in ('running','complete','failed'))
);
create index registry_ingest_runs_source_idx on public.registry_ingest_runs (source_id, started_at desc);

alter table public.registry_entities enable row level security;
alter table public.license_records enable row level security;
alter table public.registry_ingest_runs enable row level security;
revoke all on public.registry_entities, public.license_records, public.registry_ingest_runs from public, anon, authenticated;
grant all on public.registry_entities, public.license_records, public.registry_ingest_runs to service_role;
