// The file-based (ingested) sources and the rule for which of them a lookup may use.
// A file-based source is included in a lookup ONLY once it has a completed ingest run; otherwise a "0 results" answer would be
// indistinguishable from "we never loaded that state". Sources not yet loaded are reported as not_loaded instead.
//
// Where the data lives: license sources in STORAGE_LICENSE_SOURCES (CA DCA, MI LARA) are sharded Parquet in the private object-storage
// bucket (storage-sources.ts); the Postgres tables remain only for sources small enough to belong there (none today) and for business
// registries (Florida Sunbiz, when unblocked).

import type { BusinessSource, LicenseSource } from "./adapter.ts";
import { makeDbBusinessSource, makeDbLicenseSource } from "./db-sources.ts";
import type { DbAccess, DbSourceMeta } from "./db-sources.ts";
import { makeStorageLicenseSource } from "./storage-sources.ts";
import type { StorageAccess } from "./storage-sources.ts";

export const DB_BUSINESS_META: DbSourceMeta[] = [
  { id: "fl-sunbiz", label: "Florida Division of Corporations (Sunbiz) — bulk data file", state: "FL", source_dataset: "dos.fl.gov/sunbiz bulk data (fixed-width)" },
];
export const DB_LICENSE_META: DbSourceMeta[] = [
  { id: "ca-dca", label: "California Department of Consumer Affairs — monthly licensee lists", state: "CA", source_dataset: "dca.ca.gov/consumers/public_info (monthly licensee lists)", board_agency: "DCA boards" },
  { id: "ca-cslb", label: "California Contractors State License Board — License Master + Personnel files", state: "CA", source_dataset: "cslb.ca.gov/OnlineServices/DataPortal (License Master + Personnel files)", board_agency: "Contractors State License Board" },
  { id: "mi-lara", label: "Michigan LARA — license lists", state: "MI", source_dataset: "michigan.gov/lara BPL license lists (MiPLUS FOIA reports)", board_agency: "LARA" },
  { id: "fl-doh", label: "Florida Department of Health — MQA bulk data", state: "FL", source_dataset: "Florida DOH MQA bulk data", board_agency: "DOH MQA" },
];
export const STORAGE_LICENSE_SOURCES = new Set(["ca-dca", "ca-cslb", "mi-lara"]);

export interface LoadedRun { source_id: string; kind: string; file_name: string | null; finished_at: string | null; rows_upserted: number; note: string | null }

export async function loadedRuns(db: DbAccess): Promise<LoadedRun[]> {
  const f = db.fetchImpl ?? fetch;
  const res = await f(`${db.baseUrl}/rest/v1/registry_ingest_runs?status=eq.complete&select=source_id,kind,file_name,finished_at,rows_upserted,note&order=finished_at.desc`, {
    headers: { apikey: db.serviceKey, Authorization: `Bearer ${db.serviceKey}` },
  });
  if (!res.ok) return [];
  return await res.json() as LoadedRun[];
}

// `storageLoaded`: ids whose latest data is in object storage (a complete run with note 'storage'); until then a source keeps reading the database.
export function dbSources(db: DbAccess, loaded: Set<string>, storage?: StorageAccess, storageLoaded: Set<string> = new Set()): { business: BusinessSource[]; license: LicenseSource[]; notLoaded: Array<{ source_id: string; label: string; state: string; kind: "business" | "license" }> } {
  const business = DB_BUSINESS_META.filter((m) => loaded.has(m.id)).map((m) => makeDbBusinessSource(m, db));
  const license = DB_LICENSE_META.filter((m) => loaded.has(m.id)).map((m) => (storage && STORAGE_LICENSE_SOURCES.has(m.id) && storageLoaded.has(m.id) ? makeStorageLicenseSource(m, storage) : makeDbLicenseSource(m, db)));
  const notLoaded = [
    ...DB_BUSINESS_META.filter((m) => !loaded.has(m.id)).map((m) => ({ source_id: m.id, label: m.label, state: m.state, kind: "business" as const })),
    ...DB_LICENSE_META.filter((m) => !loaded.has(m.id)).map((m) => ({ source_id: m.id, label: m.label, state: m.state, kind: "license" as const })),
  ];
  return { business, license, notLoaded };
}
