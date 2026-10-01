// Object-storage-backed license sources (California DCA, Michigan LARA): the same LicenseSource contract as the live Socrata sources
// and the old database sources, but the data lives as sharded, zstd-compressed Parquet files in the PRIVATE `registry-data` bucket
// (layout in shard.ts) instead of Postgres rows. A lookup reads exactly the one shard its search term points at, parses it in memory,
// filters, returns, and persists nothing.
//
// This module has no Deno / Node / npm imports: the Parquet reader is injected (`readParquet`), so the edge function passes
// npm:hyparquet and the Node tests pass the same library from node_modules.
//
// Matching rules (deliberately the same as the database source, with ONE documented difference): individuals are matched on exact
// last name + exact-or-prefix first name; businesses on name key (exact, then prefix). Because individuals are filed under their LAST
// name, a partial LAST name cannot be found by the "business name prefix" path the way the database source could.

import type { LicenseQuery, LicenseSource, MatchMode, Outcome } from "./adapter.ts";
import type { LicenseRecord } from "./schema.ts";
import { cleanStr, nameKey, stripWildcards } from "./normalize.ts";
import { interpretLicenseQuery } from "./license-sources.ts";
import { REGISTRY_BUCKET, nameShardStem, namePath, numberPath, numberShardStem } from "./shard.ts";
import type { DbSourceMeta } from "./db-sources.ts";

export type ReadParquet = (file: ArrayBuffer) => Promise<Array<Record<string, unknown>>>;
export interface StorageAccess { baseUrl: string; serviceKey: string; readParquet: ReadParquet; fetchImpl?: typeof fetch }

type ShardFetch = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; status: number; detail: string };

async function fetchShard(st: StorageAccess, path: string): Promise<ShardFetch> {
  const f = st.fetchImpl ?? fetch;
  const res = await f(`${st.baseUrl}/storage/v1/object/${REGISTRY_BUCKET}/${path}`, { headers: { apikey: st.serviceKey, Authorization: `Bearer ${st.serviceKey}` } });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // A shard that does not exist is a real answer: nobody in this source is filed under that prefix.
    if (res.status === 404 || (res.status === 400 && /not.?found/i.test(text))) return { ok: true, rows: [] };
    return { ok: false, status: res.status, detail: text };
  }
  try { return { ok: true, rows: await st.readParquet(await res.arrayBuffer()) }; }
  catch (e) { return { ok: false, status: 500, detail: `parquet_read_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
function toLicense(r: Record<string, unknown>): LicenseRecord {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(r.details ?? "{}")); } catch { /* keep {} */ }
  return {
    license_holder_name: String(r.license_holder_name), holder_kind: r.holder_kind as LicenseRecord["holder_kind"], license_number: String(r.license_number),
    license_type: s(r.license_type), status: r.status as LicenseRecord["status"], status_raw: s(r.status_raw),
    issue_date: s(r.issue_date), expiration_date: s(r.expiration_date), state: String(r.state), board_agency: String(r.board_agency), source: String(r.source), details,
  };
}

export function makeStorageLicenseSource(meta: DbSourceMeta, st: StorageAccess): LicenseSource {
  return {
    id: meta.id, label: meta.label, state: meta.state, board_agency: meta.board_agency ?? "", source_dataset: meta.source_dataset, kind: "storage",
    async search(q: LicenseQuery, mode: MatchMode): Promise<Outcome<LicenseRecord>> {
      const t0 = Date.now();
      const iq = interpretLicenseQuery(q);
      const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
      const jobs: Array<{ path: string; keep: (r: Record<string, unknown>) => boolean }> = [];
      if (iq.person) {
        const last = nameKey(iq.person.last), first = nameKey(stripWildcards(iq.person.first));
        jobs.push({
          path: namePath(meta.id, nameShardStem(last)),
          keep: (r) => r.holder_kind === "individual" && r.last_key === last && (mode === "exact" ? r.first_key === first : String(r.first_key ?? "").startsWith(first)),
        });
      }
      if (iq.business) {
        const key = nameKey(mode === "prefix" ? stripWildcards(iq.business) : iq.business);
        // A one-character prefix cannot identify a shard; skip rather than scan everything.
        if (key.length >= 2) jobs.push({ path: namePath(meta.id, nameShardStem(key)), keep: (r) => (mode === "exact" ? nameKey(r.license_holder_name) === key : nameKey(r.license_holder_name).startsWith(key)) });
      }
      if (iq.number) {
        const num = iq.number.trim();
        jobs.push({ path: numberPath(meta.id, numberShardStem(num)), keep: (r) => String(r.license_number).toUpperCase() === num.toUpperCase() });
      }
      if (jobs.length === 0) return { ok: false, source: meta.source_dataset, error: "empty_or_invalid_query" };
      const seen = new Set<string>();
      const hits: Array<Record<string, unknown>> = [];
      let reads = 0;
      for (const j of jobs) {
        const shard = await fetchShard(st, j.path);
        reads++;
        if (!shard.ok) return { ok: false, source: meta.source_dataset, error: "storage_error", status: shard.status, detail: shard.detail };
        for (const r of shard.rows) {
          if (!j.keep(r)) continue;
          const k = `${r.license_number}|${r.license_type}|${r.license_holder_name}|${r.board_agency}`;
          if (seen.has(k)) continue;
          seen.add(k); hits.push(r);
        }
      }
      hits.sort((a, b) => (String(a.license_holder_name) < String(b.license_holder_name) ? -1 : String(a.license_holder_name) > String(b.license_holder_name) ? 1 : String(a.license_number) < String(b.license_number) ? -1 : 1));
      return { ok: true, records: hits.slice(0, limit).map(toLicense), meta: { source: meta.source_dataset, attempts: reads, ms: Date.now() - t0 } };
    },
  };
}
void cleanStr;
