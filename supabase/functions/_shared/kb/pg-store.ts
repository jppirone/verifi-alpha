// KbStore backed by Postgres through PostgREST with the service-role key (the only role with access to the kb_* tables).
// No Deno / Node APIs: base URL, key and fetch are passed in.

import type { KbEntity, KbStore, LogEntry, RecordInput } from "./kb.ts";

export interface PgAccess { baseUrl: string; serviceKey: string; fetchImpl?: typeof fetch }

export function makePgKbStore(pg: PgAccess): KbStore {
  const f = pg.fetchImpl ?? fetch;
  const headers = { apikey: pg.serviceKey, Authorization: `Bearer ${pg.serviceKey}`, "Content-Type": "application/json" };
  const enc = encodeURIComponent;
  return {
    async findByName(state, key) {
      // alias row -> entity, in one request through the foreign key
      const res = await f(`${pg.baseUrl}/rest/v1/kb_entity_names?state=eq.${enc(state)}&name_key=eq.${enc(key)}&select=kb_entities(*)&limit=1`, { headers });
      if (!res.ok) throw new Error(`kb_findByName ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = await res.json() as Array<{ kb_entities: KbEntity | null }>;
      return rows[0]?.kb_entities ?? null;
    },
    async record(input: RecordInput) {
      const res = await f(`${pg.baseUrl}/rest/v1/rpc/kb_record_verified`, { method: "POST", headers, body: JSON.stringify({ p: input }) });
      if (!res.ok) throw new Error(`kb_record_verified ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json() as { entity: KbEntity; alias_conflicts: string[] };
    },
    async log(entry: LogEntry) {
      const res = await f(`${pg.baseUrl}/rest/v1/kb_lookup_log`, { method: "POST", headers: { ...headers, Prefer: "return=representation" }, body: JSON.stringify(entry) });
      if (!res.ok) return null; // a logging failure must never fail the verification itself
      const rows = await res.json() as Array<{ id: number }>;
      return rows[0]?.id ?? null;
    },
  };
}

export async function kbStats(pg: PgAccess, sinceIso?: string): Promise<unknown> {
  const f = pg.fetchImpl ?? fetch;
  const res = await f(`${pg.baseUrl}/rest/v1/rpc/kb_lookup_stats`, { method: "POST", headers: { apikey: pg.serviceKey, Authorization: `Bearer ${pg.serviceKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_since: sinceIso ?? null }) });
  if (!res.ok) throw new Error(`kb_lookup_stats ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}
