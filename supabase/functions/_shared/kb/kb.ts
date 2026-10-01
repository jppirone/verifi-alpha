// Verification Knowledge Base, Tier 0/1 (Decision 39): an EXACT-MATCH cache in front of the state business registries.
//
//   1. normalize the employer name into a key and look it up in the cache (state + key);
//   2. fresh hit  -> answer from the cache (no registry call);  miss or stale -> ask the registry (live, authoritative);
//   3. exactly ONE registry entity whose name equals the key under the SAME normalization -> verified, written back to the cache;
//   4. anything else (several entities, none, registry down, cap hit) -> an explicit manual-verification answer, nothing cached.
// No fuzzy matching, no AI resolution, no confidence scores: a name either equals the registered name after punctuation / case /
// ampersand normalization or it does not. Every lookup is logged (hit / miss / stale and what the registry said), so the log, not a
// guess, decides whether a later AI-resolution tier is worth building.
//
// This module has no Deno / Node / npm imports. The cache store, the registry source and the clock are injected, so the whole flow runs
// offline in tests against an in-memory store and live in the edge function against Postgres + Socrata.

import type { BusinessSource } from "../registry/adapter.ts";
import type { BusinessEntity, BusinessStatus } from "../registry/schema.ts";

// How much of a state's business history its registry dataset contains. This decides what a MISS means, so it is stored with every cached
// entity and every log row, and a later resolution step can tell the kinds of source apart:
//   full_history             every entity is listed with a status (active, dissolved, merged ...)   -> "not found" = never registered under that name
//   active_only              only entities that are active today are listed                          -> "not found" may be "registered once, since closed"
//   registrations_unflagged  registrations with no status, and defunct businesses are not removed   -> a hit does not prove the business still operates
export type Completeness = "full_history" | "active_only" | "registrations_unflagged";

// Which registries are switched ON for the KB, and how complete each is. Colorado and Connecticut (full history) first; New York and Oregon
// (active only: verified 2026-10-01 -- 240 of 240 New York entities the state records as dissolved are absent from its active list, and 1.5% of
// 7,200 recent Oregon registrations have already left its active list) added after. Pennsylvania (registrations_unflagged, enabled 2026-10-01 per
// the Oct 1 decision) is the third kind: its dataset lists registrations with NO status and, by the state's own statement, keeps businesses that
// are no longer in operation, so a hit shows the business WAS registered, never that it operates; its status is "unknown", it is re-checked every
// 30 days, and operating status stays a staff confirmation. A state not listed answers "no automated source" instead of quietly widening scope.
export const KB_SOURCE_PROFILES: Record<string, { source_id: string; completeness: Completeness }> = {
  CO: { source_id: "co-sos", completeness: "full_history" },
  CT: { source_id: "ct-sots", completeness: "full_history" },
  NY: { source_id: "ny-dos", completeness: "active_only" },
  OR: { source_id: "or-sos", completeness: "active_only" },
  PA: { source_id: "pa-dos", completeness: "registrations_unflagged" },
};
export const KB_ENABLED_SOURCES: Record<string, string> = Object.fromEntries(Object.entries(KB_SOURCE_PROFILES).map(([st, p]) => [st, p.source_id]));

// A registry row is only evidence that a BUSINESS EXISTS if it is a registered entity. Connecticut's Business Master also lists name reservations
// ("Reserved", "Expired Reservation", "Reserved Cancel"), rejected filings ("Rejected"), removed records ("Removed") and filings not yet accepted
// ("Pending Filing"). A name that only ever appears as one of those is not a real employer, so such rows never count as a match.
const NOT_AN_ENTITY = /reserv|reject|removed|pending filing/i;
export const isRealEntity = (e: { status_raw: string | null }): boolean => !NOT_AN_ENTITY.test(e.status_raw ?? "");

// Normalization used for BOTH the cache key and the comparison with the registry's name, so "equal" means the same thing on both sides:
// accents removed; upper-case; "&" -> "AND"; apostrophes, periods, commas and other punctuation removed; hyphens, slashes and similar
// joiners become spaces; whitespace collapsed. Legal suffixes are NOT touched: "ACME INC" and "ACME INCORPORATED" are different keys on
// purpose (that is what a later tier may resolve; Tier 1 does not guess).
export function kbNameKey(name: string): string {
  return String(name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`".,;:!?()\[\]{}]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Re-verification policy, stored on every row when it is written (Decision 39: a staleness policy from the start).
// A live entity can change standing quickly, so it is re-checked sooner; a dissolved or merged one almost never comes back.
// A registrations_unflagged source (Pennsylvania) is always re-checked after 30 days, whatever the row says: its list can both lag a new business by up
// to a month (it is published monthly) and keep a defunct one forever, so a long-lived cache entry would hide exactly what that list cannot tell us.
export function staleAfterDays(status: BusinessStatus, completeness?: Completeness): number {
  if (completeness === "registrations_unflagged") return 30;
  switch (status) {
    case "active": case "delinquent": case "pending": return 90;
    case "dissolved": case "merged": case "inactive": return 365;
    default: return 30;
  }
}

// What the registry actually lets us say about whether the business OPERATES. Downstream steps that depend on operating status read this and
// route "unknown" to staff confirmation; existence ("registered") and operating status are different questions and a Pennsylvania hit answers only the first.
export type OperatingStatus = "active_per_registry" | "not_active" | "unknown";
export function operatingStatus(status: BusinessStatus): OperatingStatus {
  switch (status) {
    case "active": return "active_per_registry";
    case "dissolved": case "merged": case "inactive": return "not_active";
    default: return "unknown"; // delinquent, pending, other, unknown: the registry does not say it is operating
  }
}
// operating_status is what the registry lets us say; operating_status_confirmation_required is the ROUTING signal and is deliberately narrower: it is true
// ONLY when the registry publishes no status at all for the entity (status "unknown": Pennsylvania). A registry that DOES publish a status -- including
// "delinquent" or "pending" -- is read by staff as it always was, so Colorado, Connecticut, New York and Oregon never trigger the extra confirmation
// (corrected 2026-10-01: it had also been true for delinquent / pending / other, which would have sent over a million Colorado entities to staff).
const opFields = (e: { status: BusinessStatus }) => ({ operating_status: operatingStatus(e.status), operating_status_confirmation_required: e.status === "unknown" });

export interface KbEntity {
  id: string; entity_kind: string; state: string; registry_source_id: string; registry_entity_id: string; name: string;
  status: BusinessStatus; status_raw: string | null; entity_type: string | null; registration_date: string | null; source_dataset: string;
  details: Record<string, unknown>; first_verified_at: string; last_verified_at: string; verification_count: number; stale_after_days: number; last_outcome: string; source_completeness: Completeness;
}
export interface RecordInput {
  state: string; registry_source_id: string; registry_entity_id: string; name: string; status: BusinessStatus; status_raw: string | null; entity_type: string | null;
  registration_date: string | null; source_dataset: string; details: Record<string, unknown>; stale_after_days: number; source_completeness: Completeness; alias_keys: Array<{ key: string; seen: string }>;
}
export type CacheResult = "hit" | "stale" | "miss" | "bypass" | "n/a";
export type FinalOutcome = "verified" | "not_found" | "ambiguous" | "conflict" | "inconclusive" | "no_automated_source";
export interface LogEntry {
  query_name: string; query_name_key: string; query_state: string; caller: string | null; cache_result: CacheResult; final_outcome: FinalOutcome;
  entity_id: string | null; registry_queried: boolean; registry_source_id: string | null; registry_calls: number; registry_ms: number | null; total_ms: number;
  status_seen: string | null; source_completeness: Completeness | null; detail: Record<string, unknown>;
}
export interface KbStore {
  findByName(state: string, key: string): Promise<KbEntity | null>;
  record(input: RecordInput): Promise<{ entity: KbEntity; alias_conflicts: string[] }>;
  log(entry: LogEntry): Promise<number | null>;
}

// ---------------------------------------------------------------------------------------------------------------- registry find
export type RegistryFind =
  | { kind: "match"; entity: BusinessEntity; resolution?: Resolution; calls: number; ms: number }
  | { kind: "ambiguous"; matches: BusinessEntity[]; calls: number; ms: number }
  | { kind: "none"; calls: number; ms: number }
  | { kind: "inconclusive"; reason: "registry_error" | "result_cap_hit"; detail?: string; calls: number; ms: number };

// When several REAL registry entities carry exactly the same (normalized) name but exactly ONE of them is active, that one is the answer: the
// others are dissolved / merged / forfeited / delinquent predecessors or namesakes. Registries do not allow two live entities with an
// indistinguishable name, so "exactly one active" is a deterministic rule, not a guess. Zero active, or two or more, stays ambiguous (a human decides).
// The other entities are kept with the answer so staff can see what the rule passed over.
export interface Resolution { rule: "single_active_among_same_name"; considered: number; others: Array<{ registry_entity_id: string; status: string; status_raw: string | null; entity_type: string | null; registration_date: string | null }> }
export function resolveSameName(matches: BusinessEntity[]): { entity: BusinessEntity; resolution: Resolution } | null {
  const active = matches.filter((m) => m.status === "active");
  if (active.length !== 1) return null;
  const chosen = active[0];
  return {
    entity: chosen,
    resolution: {
      rule: "single_active_among_same_name", considered: matches.length,
      others: matches.filter((m) => m !== chosen).map((m) => ({ registry_entity_id: m.entity_id, status: m.status, status_raw: m.status_raw, entity_type: m.entity_type, registration_date: m.registration_date })),
    },
  };
}

const CAP = 100;

// Three bounded, deterministic steps; the first one that yields an entity whose normalized name equals the key wins:
//   1. exact on the name as typed;  2. prefix on the normalized key;  3. prefix on the first word (catches registered punctuation such as
//   "DAVITA, INC." for a typed "DaVita Inc", which a prefix on the whole key cannot see).
// Only entities whose OWN name normalizes to exactly the key are accepted -- a prefix hit that is merely similar is never a match.
export async function findInRegistry(source: BusinessSource, name: string): Promise<RegistryFind> {
  const t0 = Date.now();
  const key = kbNameKey(name);
  let calls = 0, capped = false;
  const steps: Array<{ q: string; mode: "exact" | "prefix" }> = [{ q: name, mode: "exact" }, { q: key, mode: "prefix" }];
  const first = key.split(" ")[0];
  if (first && first.length >= 3 && first !== key) steps.push({ q: first, mode: "prefix" });
  const seen = new Set<string>();
  for (const s of steps) {
    calls++;
    const out = await source.search({ name: s.q, limit: CAP }, s.mode);
    if (!out.ok) return { kind: "inconclusive", reason: "registry_error", detail: `${out.error}${out.detail ? ": " + out.detail : ""}`.slice(0, 200), calls, ms: Date.now() - t0 };
    if (out.records.length >= CAP) capped = true;
    const matches = out.records.filter((r) => kbNameKey(r.entity_name) === key && isRealEntity(r) && !seen.has(r.entity_id));
    for (const m of out.records) seen.add(m.entity_id);
    if (matches.length === 1) return { kind: "match", entity: matches[0], calls, ms: Date.now() - t0 };
    if (matches.length > 1) {
      const r = resolveSameName(matches);
      if (r) return { kind: "match", entity: r.entity, resolution: r.resolution, calls, ms: Date.now() - t0 };
      return { kind: "ambiguous", matches, calls, ms: Date.now() - t0 };
    }
  }
  // nothing matched; if any step was cut off by the result cap the missing entity may be beyond it, so a miss proves nothing
  if (capped) return { kind: "inconclusive", reason: "result_cap_hit", calls, ms: Date.now() - t0 };
  return { kind: "none", calls, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------- verify flow
export interface VerifyRequest { name: string; state: string; caller: string | null; force_refresh?: boolean }
export interface VerifyDeps { store: KbStore; registryFor: (state: string) => BusinessSource | null; now?: () => number }
export type VerifyStatus = FinalOutcome;
export interface VerifyResponse {
  status: VerifyStatus; manual_verification_required: boolean; message: string; from_cache: boolean; cache_result: CacheResult;
  query: { name: string; name_key: string; state: string };
  entity?: KbEntity; stale_entity?: KbEntity; resolution?: Resolution; candidates?: Array<{ registry_entity_id: string; name: string; status: string; status_raw: string | null; entity_type: string | null; registration_date: string | null }>;
  registry: { queried: boolean; source_id: string | null; completeness: Completeness | null; calls: number; ms: number | null };
  // active_only registries only: an entity this knowledge base HAD verified is no longer on the registry's active list, which means it has most
  // likely dissolved, merged or been withdrawn since (a deterministic inference from "was active, now absent from an active-only list").
  disappeared_from_active_register?: boolean;
  // Present whenever an entity is returned. "unknown" (every Pennsylvania hit, and e.g. a delinquent Colorado entity) means the registry does not
  // say the business operates: staff confirm it wherever operating status matters downstream.
  operating_status?: OperatingStatus;
  operating_status_confirmation_required?: boolean;
  log_id: number | null;
}

const isFresh = (e: KbEntity, now: number) => now - new Date(e.last_verified_at).getTime() < e.stale_after_days * 86_400_000;

export async function verifyBusiness(deps: VerifyDeps, req: VerifyRequest): Promise<VerifyResponse> {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const state = req.state.toUpperCase();
  const key = kbNameKey(req.name);
  const query = { name: req.name, name_key: key, state };
  const finish = async (r: Omit<VerifyResponse, "query" | "log_id">, log: Omit<LogEntry, "query_name" | "query_name_key" | "query_state" | "caller" | "total_ms">): Promise<VerifyResponse> => {
    const log_id = await deps.store.log({ query_name: req.name, query_name_key: key, query_state: state, caller: req.caller, total_ms: now() - t0, ...log }).catch(() => null);
    return { ...r, query, log_id };
  };

  const profile = KB_SOURCE_PROFILES[state];
  const sourceId = profile?.source_id;
  const completeness: Completeness | null = profile?.completeness ?? null;
  const activeOnlyNote = " This registry lists active entities only, so this says the employer is active today and nothing about its earlier history.";
  const unflaggedNote = " Operating status is UNKNOWN: this registry list publishes no status and keeps businesses that are no longer in operation (the state cannot remove them), so a listing shows the business was registered, not that it operates today. Staff must confirm operating status wherever it matters.";
  const source = sourceId ? deps.registryFor(state) : null;
  if (!source) {
    return finish({
      status: "no_automated_source", manual_verification_required: true, from_cache: false, cache_result: "n/a",
      message: `No automated business registry is enabled for ${state}: look this employer up by hand. Needs manual verification.`,
      registry: { queried: false, source_id: null, completeness: null, calls: 0, ms: null },
    }, { cache_result: "n/a", final_outcome: "no_automated_source", entity_id: null, registry_queried: false, registry_source_id: null, registry_calls: 0, registry_ms: null, status_seen: null, source_completeness: null, detail: {} });
  }

  const cached = await deps.store.findByName(state, key);
  if (cached && !req.force_refresh && isFresh(cached, now())) {
    return finish({
      status: "verified", manual_verification_required: false, from_cache: true, cache_result: "hit", entity: cached, ...opFields(cached),
      message: `Verified as registered, from the knowledge base (last confirmed against the ${state} registry ${cached.last_verified_at.slice(0, 10)}).${cached.source_completeness === "active_only" ? activeOnlyNote : cached.source_completeness === "registrations_unflagged" ? unflaggedNote : ""}`,
      registry: { queried: false, source_id: cached.registry_source_id, completeness: cached.source_completeness, calls: 0, ms: null },
    }, { cache_result: "hit", final_outcome: "verified", entity_id: cached.id, registry_queried: false, registry_source_id: cached.registry_source_id, registry_calls: 0, registry_ms: null, status_seen: cached.status, source_completeness: cached.source_completeness, detail: {} });
  }
  const cache_result: CacheResult = cached ? (req.force_refresh ? "bypass" : "stale") : "miss";

  let found: RegistryFind;
  try { found = await findInRegistry(source, req.name); }
  catch (e) { found = { kind: "inconclusive", reason: "registry_error", detail: String((e as Error)?.message ?? e).slice(0, 200), calls: 0, ms: now() - t0 }; }
  const registry = { queried: true, source_id: sourceId, completeness, calls: found.calls, ms: found.ms };
  const base = { cache_result, entity_id: cached?.id ?? null, registry_queried: true, registry_source_id: sourceId, registry_calls: found.calls, registry_ms: found.ms, status_seen: null as string | null, source_completeness: completeness };

  if (found.kind === "match") {
    const m = found.entity;
    if (cached && cached.registry_entity_id !== m.entity_id) {
      return finish({
        status: "conflict", manual_verification_required: true, from_cache: false, cache_result, stale_entity: cached, registry,
        message: `The knowledge base had "${key}" as ${cached.name} (${cached.registry_entity_id}) but the ${state} registry now returns a different entity (${m.entity_id}). Needs manual verification; the cache was not changed.`,
      }, { ...base, final_outcome: "conflict", status_seen: m.status, detail: { cached_entity: cached.registry_entity_id, registry_entity: m.entity_id } });
    }
    const alias_keys = [{ key, seen: req.name }];
    const officialKey = kbNameKey(m.entity_name);
    if (officialKey !== key) alias_keys.push({ key: officialKey, seen: m.entity_name });
    const { entity, alias_conflicts } = await deps.store.record({
      state, registry_source_id: sourceId, registry_entity_id: m.entity_id, name: m.entity_name, status: m.status, status_raw: m.status_raw, entity_type: m.entity_type,
      registration_date: m.registration_date, source_dataset: m.source_dataset, details: found.resolution ? { ...m.details, resolution: found.resolution } : m.details,
      stale_after_days: staleAfterDays(m.status, completeness!), source_completeness: completeness!, alias_keys,
    });
    if (alias_conflicts.length) {
      return finish({
        status: "conflict", manual_verification_required: true, from_cache: false, cache_result, entity, registry,
        message: `Verified in the ${state} registry, but the name key ${alias_conflicts.join(", ")} already points at a different knowledge-base entity. Needs manual verification.`,
      }, { ...base, entity_id: entity.id, final_outcome: "conflict", status_seen: m.status, detail: { alias_conflicts } });
    }
    const resNote = found.resolution ? ` ${found.resolution.considered} registered entities carry exactly this name; the one active entity was chosen and the others (${found.resolution.others.map((o) => o.status_raw ?? o.status).join(", ")}) are listed under resolution.` : "";
    return finish({
      status: "verified", manual_verification_required: false, from_cache: false, cache_result, entity, ...opFields(entity), registry, ...(found.resolution ? { resolution: found.resolution } : {}),
      message: `Verified as registered against the ${state} registry (${m.status_raw ?? (m.status === "unknown" ? "status not published" : m.status)}) and written to the knowledge base${cached ? " (re-verified)" : ""}.${resNote}${completeness === "active_only" ? activeOnlyNote : completeness === "registrations_unflagged" ? unflaggedNote : ""}`,
    }, { ...base, entity_id: entity.id, final_outcome: "verified", status_seen: m.status, detail: found.resolution ? { resolved_by: found.resolution.rule, same_name_entities: found.resolution.considered } : {} });
  }

  if (found.kind === "ambiguous") {
    return finish({
      status: "ambiguous", manual_verification_required: true, from_cache: false, cache_result, registry, ...(cached ? { stale_entity: cached } : {}),
      candidates: found.matches.slice(0, 10).map((x) => ({ registry_entity_id: x.entity_id, name: x.entity_name, status: x.status, status_raw: x.status_raw, entity_type: x.entity_type, registration_date: x.registration_date })),
      message: `${found.matches.length} registered ${state} entities carry exactly this name and ${completeness === "registrations_unflagged" ? "this registry publishes no status to tell them apart" : found.matches.filter((x) => x.status === "active").length === 0 ? "none is active" : "more than one is active"}, so which one this employer is cannot be decided automatically. Needs manual verification. Nothing was cached.`,
    }, { ...base, final_outcome: "ambiguous", detail: { matches: found.matches.length, active: found.matches.filter((x) => x.status === "active").length } });
  }

  if (found.kind === "none") {
    const activeOnly = completeness === "active_only";
    const disappeared = activeOnly && !!cached;
    return finish({
      status: "not_found", manual_verification_required: true, from_cache: false, cache_result, registry, ...(cached ? { stale_entity: cached } : {}), ...(disappeared ? { disappeared_from_active_register: true } : {}),
      message: activeOnly
        ? `No ACTIVE ${state} registry entity has exactly this name. This registry lists active entities only, so the employer may have existed and since dissolved, merged or been withdrawn (or be registered under a different legal name, or in another state). Needs manual verification.${disappeared ? " The knowledge base had verified it as active earlier and it is no longer on the active list, so it has most likely closed since." : ""}`
        : completeness === "registrations_unflagged"
        ? `No ${state} registry entry has exactly this name. This list keeps defunct businesses, so the absence is a fairly strong sign that nothing was registered in ${state} under this name, but it is published monthly (a business registered in the last month may not be listed yet) and the employer may use a different legal name or another state. Needs manual verification.${cached ? " It was previously verified in the knowledge base, so check whether it was renamed." : ""}`
        : `No ${state} registry entity has exactly this name. That does not prove the employer does not exist (it may be registered under a different legal name, or in another state). Needs manual verification.${cached ? " It was previously verified in the knowledge base, so check whether it was renamed or closed." : ""}`,
    }, { ...base, final_outcome: "not_found", detail: { previously_verified: !!cached, ...(activeOnly ? { active_only_registry: true, disappeared_from_active_register: disappeared } : {}) } });
  }

  return finish({
    status: "inconclusive", manual_verification_required: true, from_cache: false, cache_result, registry, ...(cached ? { stale_entity: cached } : {}),
    message: found.reason === "result_cap_hit"
      ? `The ${state} registry search returned its maximum number of results without an exact match, so the entity may exist beyond what could be searched. Needs manual verification.`
      : `The ${state} registry could not be searched (${found.detail ?? "error"}), so this is not a "not found". Needs manual verification.`,
  }, { ...base, final_outcome: "inconclusive", detail: { reason: found.reason, error: found.reason === "registry_error" ? found.detail : undefined } });
}
