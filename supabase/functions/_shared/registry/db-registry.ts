// The database-backed (file-ingested) sources and the rule for which of them a lookup may use.
// A database source is included in a lookup ONLY once it has a completed ingest run; otherwise a "0 results" answer would be
// indistinguishable from "we never loaded that state". Sources not yet loaded are reported as not_loaded instead.

import type { BusinessSource, LicenseSource } from "./adapter.ts";
import { makeDbBusinessSource, makeDbLicenseSource } from "./db-sources.ts";
import type { DbAccess, DbSourceMeta } from "./db-sources.ts";

export const DB_BUSINESS_META: DbSourceMeta[] = [
  { id: "fl-sunbiz", label: "Florida Division of Corporations (Sunbiz) — bulk data file", state: "FL", source_dataset: "dos.fl.gov/sunbiz bulk data (fixed-width)" },
];
export const DB_LICENSE_META: DbSourceMeta[] = [
  { id: "ca-dca", label: "California Department of Consumer Affairs — monthly licensee lists", state: "CA", source_dataset: "dca.ca.gov/consumers/public_info (monthly licensee lists)", board_agency: "DCA boards" },
  { id: "mi-lara", label: "Michigan LARA — license roster (manual refresh)", state: "MI", source_dataset: "Michigan LARA FOIA roster", board_agency: "LARA" },
  { id: "fl-doh", label: "Florida Department of Health — MQA bulk data", state: "FL", source_dataset: "Florida DOH MQA bulk data", board_agency: "DOH MQA" },
];

export interface LoadedRun { source_id: string; kind: string; file_name: string | null; finished_at: string | null; rows_upserted: number }

export async function loadedRuns(db: DbAccess): Promise<LoadedRun[]> {
  const f = db.fetchImpl ?? fetch;
  const res = await f(`${db.baseUrl}/rest/v1/registry_ingest_runs?status=eq.complete&select=source_id,kind,file_name,finished_at,rows_upserted&order=finished_at.desc`, {
    headers: { apikey: db.serviceKey, Authorization: `Bearer ${db.serviceKey}` },
  });
  if (!res.ok) return [];
  return await res.json() as LoadedRun[];
}

export function dbSources(db: DbAccess, loaded: Set<string>): { business: BusinessSource[]; license: LicenseSource[]; notLoaded: Array<{ source_id: string; label: string; state: string; kind: "business" | "license" }> } {
  const business = DB_BUSINESS_META.filter((m) => loaded.has(m.id)).map((m) => makeDbBusinessSource(m, db));
  const license = DB_LICENSE_META.filter((m) => loaded.has(m.id)).map((m) => makeDbLicenseSource(m, db));
  const notLoaded = [
    ...DB_BUSINESS_META.filter((m) => !loaded.has(m.id)).map((m) => ({ source_id: m.id, label: m.label, state: m.state, kind: "business" as const })),
    ...DB_LICENSE_META.filter((m) => !loaded.has(m.id)).map((m) => ({ source_id: m.id, label: m.label, state: m.state, kind: "license" as const })),
  ];
  return { business, license, notLoaded };
}
