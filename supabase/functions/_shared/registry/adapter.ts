// Adapter contracts shared by every business-registry and license source. A source is either:
//   * "socrata"  -- queried live (no data stored by us), or
//   * "database" -- a file-based source (fixed-width flat file, spreadsheet) ingested into our own table and queried there.
// Either way a caller gets the SAME normalized record shape back (schema.ts) and the same outcome envelope, so lookup code
// is written once and never special-cases a source.

import type { BusinessEntity, LicenseRecord } from "./schema.ts";

export type MatchMode = "exact" | "prefix";
export type MatchType = "exact" | "prefix" | "id" | "number";

export interface AdapterMeta {
  source: string; // "<domain>/<dataset id>" or "db:<source id>"
  attempts: number; // HTTP attempts made (1 = first try succeeded)
  ms: number;
  // For datasets that are one row per associated party (Oregon, Pennsylvania): the raw source rows the query touched and the
  // distinct entities they collapse to. Present only when the adapter dedups.
  raw_rows?: number;
  entities?: number;
}

export type Outcome<T> =
  | { ok: true; records: T[]; meta: AdapterMeta }
  | { ok: false; source: string; error: string; status?: number; detail?: string };

export interface BusinessQuery { name?: string; entity_id?: string; limit?: number }
export interface LicenseQuery {
  name?: string; // free text: a person ("First Last" / "Last, First") or a business name
  first_name?: string;
  last_name?: string;
  business_name?: string;
  license_number?: string;
  limit?: number;
}

export interface BusinessSource {
  id: string; // stable short id, e.g. "co-sos"
  label: string;
  state: string;
  source_dataset: string;
  kind: "socrata" | "database" | "storage";
  search(q: BusinessQuery, mode: MatchMode): Promise<Outcome<BusinessEntity>>;
  // Optional: adds related data (e.g. Connecticut's agents / principals) into record.details for the records it is given.
  enrich?(records: BusinessEntity[]): Promise<void>;
  // Optional: evidence for one-row-per-party datasets -- raw row count vs distinct entity count for a name prefix.
  dedupEvidence?(namePrefix: string): Promise<{ ok: true; raw_rows: number; entities: number } | { ok: false; error: string }>;
}

export interface LicenseSource {
  id: string;
  label: string;
  state: string;
  board_agency: string;
  source_dataset: string;
  kind: "socrata" | "database" | "storage";
  search(q: LicenseQuery, mode: MatchMode): Promise<Outcome<LicenseRecord>>;
}
