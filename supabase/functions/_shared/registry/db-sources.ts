// Database-backed sources: file-based datasets (Florida Sunbiz, California DCA, Michigan / Delaware rosters) that were ingested
// into registry_entities / license_records (migration 20260930020000_registry_tables.sql). They implement the same
// BusinessSource / LicenseSource contracts as the live Socrata sources, so lookup.ts treats every source identically.
//
// Queries go to PostgREST with the service-role key, which is passed in (this module has no Deno / Node APIs). Filter values
// are URL-encoded; prefix searches use PostgREST's `like` with a trailing `*`, and the wildcard characters a caller might type
// are stripped first.

import type { BusinessQuery, BusinessSource, LicenseQuery, LicenseSource, MatchMode, Outcome } from "./adapter.ts";
import type { BusinessEntity, LicenseRecord } from "./schema.ts";
import { cleanStr, nameKey, stripWildcards } from "./normalize.ts";
import { interpretLicenseQuery } from "./license-sources.ts";

export interface DbAccess { baseUrl: string; serviceKey: string; fetchImpl?: typeof fetch }
export interface DbSourceMeta { id: string; label: string; state: string; source_dataset: string; board_agency?: string }

async function rest(db: DbAccess, path: string): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; status: number; detail: string }> {
  const f = db.fetchImpl ?? fetch;
  const res = await f(`${db.baseUrl}/rest/v1/${path}`, { headers: { apikey: db.serviceKey, Authorization: `Bearer ${db.serviceKey}`, Accept: "application/json" } });
  if (!res.ok) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
  const rows = await res.json();
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

const enc = encodeURIComponent;
const likeValue = (mode: MatchMode, key: string) => mode === "exact" ? `eq.${enc(key)}` : `like.${enc(stripWildcards(key) + "*")}`;
const clampLimit = (n?: number) => Math.min(Math.max(n ?? 25, 1), 100);

const toBusiness = (r: Record<string, unknown>): BusinessEntity => ({
  entity_name: String(r.entity_name), entity_id: String(r.entity_id), status: r.status as BusinessEntity["status"], status_raw: (r.status_raw as string | null) ?? null,
  registration_date: (r.registration_date as string | null) ?? null, entity_type: (r.entity_type as string | null) ?? null,
  state: String(r.state), source_dataset: String(r.source_dataset), details: (r.details as Record<string, unknown>) ?? {},
});
const toLicense = (r: Record<string, unknown>): LicenseRecord => ({
  license_holder_name: String(r.license_holder_name), holder_kind: r.holder_kind as LicenseRecord["holder_kind"], license_number: String(r.license_number),
  license_type: (r.license_type as string | null) ?? null, status: r.status as LicenseRecord["status"], status_raw: (r.status_raw as string | null) ?? null,
  issue_date: (r.issue_date as string | null) ?? null, expiration_date: (r.expiration_date as string | null) ?? null, state: String(r.state),
  board_agency: String(r.board_agency), source: String(r.source), details: (r.details as Record<string, unknown>) ?? {},
});

export function makeDbBusinessSource(meta: DbSourceMeta, db: DbAccess): BusinessSource {
  return {
    id: meta.id, label: meta.label, state: meta.state, source_dataset: meta.source_dataset, kind: "database",
    async search(q: BusinessQuery, mode: MatchMode): Promise<Outcome<BusinessEntity>> {
      const t0 = Date.now();
      const parts: string[] = [`source_id=eq.${enc(meta.id)}`];
      const name = cleanStr(q.name), id = cleanStr(q.entity_id);
      if (!name && !id) return { ok: false, source: meta.source_dataset, error: "empty_or_invalid_query" };
      if (name) parts.push(`name_key=${likeValue(mode, nameKey(name))}`);
      if (id) parts.push(`entity_id=eq.${enc(id)}`);
      const r = await rest(db, `registry_entities?${parts.join("&")}&order=name_key.asc&limit=${clampLimit(q.limit)}`);
      if (!r.ok) return { ok: false, source: meta.source_dataset, error: "database_error", status: r.status, detail: r.detail };
      return { ok: true, records: r.rows.map(toBusiness), meta: { source: meta.source_dataset, attempts: 1, ms: Date.now() - t0 } };
    },
  };
}

export function makeDbLicenseSource(meta: DbSourceMeta, db: DbAccess): LicenseSource {
  return {
    id: meta.id, label: meta.label, state: meta.state, board_agency: meta.board_agency ?? "", source_dataset: meta.source_dataset, kind: "database",
    async search(q: LicenseQuery, mode: MatchMode): Promise<Outcome<LicenseRecord>> {
      const t0 = Date.now();
      const iq = interpretLicenseQuery(q);
      const limit = clampLimit(q.limit);
      const queries: string[] = [];
      const base = `source_id=eq.${enc(meta.id)}`;
      if (iq.person) {
        queries.push(`${base}&last_key=eq.${enc(iq.person.last)}&first_key=${mode === "exact" ? `eq.${enc(iq.person.first)}` : `like.${enc(stripWildcards(iq.person.first) + "*")}`}&limit=${limit}`);
      }
      if (iq.business) queries.push(`${base}&name_key=${likeValue(mode, nameKey(iq.business))}&limit=${limit}`);
      if (iq.number) queries.push(`${base}&license_number=eq.${enc(iq.number)}&limit=${limit}`);
      if (queries.length === 0) return { ok: false, source: meta.source_dataset, error: "empty_or_invalid_query" };
      const seen = new Set<string>();
      const records: LicenseRecord[] = [];
      for (const qs of queries) {
        const r = await rest(db, `license_records?${qs}&order=name_key.asc,license_number.asc`);
        if (!r.ok) return { ok: false, source: meta.source_dataset, error: "database_error", status: r.status, detail: r.detail };
        for (const row of r.rows) {
          const key = `${row.license_number}|${row.license_type}|${row.license_holder_name}`;
          if (seen.has(key)) continue;
          seen.add(key); records.push(toLicense(row));
        }
      }
      return { ok: true, records: records.slice(0, limit), meta: { source: meta.source_dataset, attempts: 1, ms: Date.now() - t0 } };
    },
  };
}
