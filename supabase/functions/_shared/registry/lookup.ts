// The cross-source lookup: one call, every (or a chosen subset of) business-registry or license source, one result shape.
// Callers never branch on source. Each source runs in parallel with its own timeout; one source failing (a portal down, a
// rate limit that outlasted its retries) is REPORTED per source and never hides the others, and a failure is never reported
// as "not found".

import type { BusinessSource, LicenseSource, MatchType, Outcome } from "./adapter.ts";
import type { BusinessEntity, LicenseRecord } from "./schema.ts";
import { cleanStr } from "./normalize.ts";

export interface SourceReport {
  source_id: string;
  label: string;
  state: string;
  kind: "socrata" | "database";
  source_dataset: string;
  ok: boolean;
  count: number;
  ms: number;
  attempts?: number;
  raw_rows?: number; // one-row-per-party datasets: raw rows the query touched ...
  entities?: number; //  ... and the distinct entities they collapse to
  error?: string;
  detail?: string;
}
export interface Hit<T> { source_id: string; match_type: MatchType; name_match?: boolean; record: T }

export interface BusinessLookup { name?: string; entity_id?: string; states?: string[]; sources?: string[]; limit?: number; include_people?: boolean }
export interface LicenseLookupReq { name?: string; first_name?: string; last_name?: string; business_name?: string; license_number?: string; states?: string[]; sources?: string[]; limit?: number }

const PER_SOURCE_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); resolve(onTimeout()); void e; });
  });
}

function pick<T extends { id: string; state: string }>(all: T[], states?: string[], ids?: string[]): T[] {
  const st = states?.map((s) => s.toUpperCase());
  return all.filter((s) => (!st || st.length === 0 || st.includes(s.state)) && (!ids || ids.length === 0 || ids.includes(s.id)));
}

export async function lookupBusiness(all: BusinessSource[], req: BusinessLookup): Promise<{ hits: Hit<BusinessEntity>[]; reports: SourceReport[] }> {
  const chosen = pick(all, req.states, req.sources);
  const name = cleanStr(req.name);
  const id = cleanStr(req.entity_id);
  const results = await Promise.all(chosen.map(async (s) => {
    const t0 = Date.now();
    const base = { source_id: s.id, label: s.label, state: s.state, kind: s.kind, source_dataset: s.source_dataset };
    const failed = (o: Extract<Outcome<BusinessEntity>, { ok: false }>): { hits: Hit<BusinessEntity>[]; report: SourceReport } =>
      ({ hits: [], report: { ...base, ok: false, count: 0, ms: Date.now() - t0, error: o.error, detail: o.detail } });
    const run = (q: { name?: string; entity_id?: string }, mode: "exact" | "prefix") =>
      withTimeout(s.search({ ...q, limit: req.limit }, mode), PER_SOURCE_TIMEOUT_MS, () => ({ ok: false as const, source: s.source_dataset, error: "source_timeout" }));
    let match: MatchType = id && !name ? "id" : "exact";
    let out = await run({ name: name ?? undefined, entity_id: id ?? undefined }, "exact");
    if (!out.ok) return failed(out);
    if (out.records.length === 0 && name && !id) {
      const p = await run({ name }, "prefix");
      if (!p.ok) return failed(p);
      out = p; match = "prefix";
    }
    if (req.include_people && s.enrich && out.records.length) await withTimeout(s.enrich(out.records), PER_SOURCE_TIMEOUT_MS, () => undefined);
    return {
      hits: out.records.map((record) => ({ source_id: s.id, match_type: match, record })),
      report: { ...base, ok: true, count: out.records.length, ms: Date.now() - t0, attempts: out.meta.attempts, raw_rows: out.meta.raw_rows, entities: out.meta.entities },
    };
  }));
  return { hits: results.flatMap((r) => r.hits), reports: results.map((r) => r.report) };
}

const lastToken = (s: string) => (s.replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean).pop() || "").toUpperCase();

export async function lookupLicense(all: LicenseSource[], req: LicenseLookupReq): Promise<{ hits: Hit<LicenseRecord>[]; reports: SourceReport[] }> {
  const chosen = pick(all, req.states, req.sources);
  const hasName = !!(cleanStr(req.name) || cleanStr(req.business_name) || (cleanStr(req.first_name) && cleanStr(req.last_name)));
  const hasNumber = !!cleanStr(req.license_number);
  const wantLast = cleanStr(req.last_name) ? cleanStr(req.last_name)!.toUpperCase() : cleanStr(req.name) ? lastToken(req.name!) : cleanStr(req.business_name) ? lastToken(req.business_name!) : "";
  const results = await Promise.all(chosen.map(async (s) => {
    const t0 = Date.now();
    const base = { source_id: s.id, label: s.label, state: s.state, kind: s.kind, source_dataset: s.source_dataset };
    const failed = (o: Extract<Outcome<LicenseRecord>, { ok: false }>) => ({ hits: [] as Hit<LicenseRecord>[], report: { ...base, ok: false, count: 0, ms: Date.now() - t0, error: o.error, detail: o.detail } as SourceReport });
    const run = (mode: "exact" | "prefix") =>
      withTimeout(s.search({ name: req.name, first_name: req.first_name, last_name: req.last_name, business_name: req.business_name, license_number: req.license_number, limit: req.limit }, mode),
        PER_SOURCE_TIMEOUT_MS, () => ({ ok: false as const, source: s.source_dataset, error: "source_timeout" }));
    let match: MatchType = hasNumber && !hasName ? "number" : "exact";
    let out = await run("exact");
    if (!out.ok) return failed(out);
    if (out.records.length === 0 && hasName && !hasNumber) {
      const p = await run("prefix");
      if (!p.ok) return failed(p);
      out = p; match = "prefix";
    }
    return {
      hits: out.records.map((record) => ({
        source_id: s.id, match_type: match,
        // when both a name and a number were given, say whether the returned holder actually carries that name: license numbers
        // are not unique across boards in every source (Colorado DORA), so a number hit alone is not proof of identity.
        ...(hasName && hasNumber && wantLast ? { name_match: record.license_holder_name.toUpperCase().includes(wantLast) } : {}),
        record,
      })),
      report: { ...base, ok: true, count: out.records.length, ms: Date.now() - t0, attempts: out.meta.attempts } as SourceReport,
    };
  }));
  return { hits: results.flatMap((r) => r.hits), reports: results.map((r) => r.report) };
}
