// Shard layout for file-based sources kept in object storage (bucket `registry-data`) instead of Postgres.
//
// Every record is written to TWO places, one per way a lookup can reach it:
//   <source_id>/name/<xx>.parquet  -- by NAME. xx = first two characters of the shard key: an individual's LAST name, or a business's whole
//                                     name key. Individuals and businesses share a file; rows carry holder_kind, last_key, first_key; the full name key is recomputed from license_holder_name at read time (not stored).
//   <source_id>/num/<hh>.parquet   -- by LICENSE NUMBER. hh = FNV-1a(license number) & 0xff as two hex digits.
// A lookup therefore reads exactly one name shard (per search term) or exactly one number shard, never the whole dataset.
// Writer (tools/registry/build-shards.ts) and reader (storage-sources.ts) both use these functions, so they cannot drift.

import { nameKey } from "./normalize.ts";

export const REGISTRY_BUCKET = "registry-data";
export const PARQUET_COLUMNS = [
  "last_key", "first_key", "license_holder_name", "holder_kind", "license_number", "license_type",
  "status", "status_raw", "issue_date", "expiration_date", "state", "board_agency", "source", "details",
] as const;
export type ShardRow = Record<(typeof PARQUET_COLUMNS)[number], string | null>;

const ch = (c: string) => (/[A-Z0-9]/.test(c) ? c.toLowerCase() : "_");

// First two characters of an (already upper-cased, whitespace-collapsed) key, as a safe file stem: "wi", "o_" (O'BRIEN -> "o_"), "a_".
export function nameShardStem(key: string): string {
  const k = nameKey(key);
  return ch(k[0] ?? "_") + ch(k[1] ?? "_");
}

// FNV-1a 32-bit over the upper-cased, trimmed license number; low byte as two hex digits.
export function numberShardStem(licenseNumber: string): string {
  const s = licenseNumber.trim().toUpperCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h & 0xff).toString(16).padStart(2, "0");
}

export const namePath = (sourceId: string, stem: string) => `${sourceId}/name/${stem}.parquet`;
export const numberPath = (sourceId: string, stem: string) => `${sourceId}/num/${stem}.parquet`;
export const manifestPath = (sourceId: string) => `${sourceId}/manifest.json`;

// Allowed object paths for registry-ingest put_shard (anything else is refused).
export function isValidShardPath(sourceId: string, path: string): boolean {
  const esc = sourceId.replace(/[^a-z0-9-]/g, "");
  if (esc !== sourceId) return false;
  return new RegExp(`^${esc}/(name/[a-z0-9_]{2}\\.parquet|num/[0-9a-f]{2}\\.parquet|manifest\\.json)$`).test(path);
}

// The shard key a record is filed under in the by-name family.
export function nameShardKeyFor(row: { holder_kind: string; last_key: string | null; name_key: string }): string {
  return row.holder_kind === "individual" && row.last_key ? row.last_key : row.name_key;
}
