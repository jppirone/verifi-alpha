// Offline tests of the Knowledge Base flow (exact-match cache in front of a registry): an in-memory store with the same semantics as the
// kb_record_verified SQL function, and a scripted fake registry that counts its calls.
import assert from "node:assert/strict";
import { kbNameKey, staleAfterDays, verifyBusiness, findInRegistry, type KbEntity, type KbStore, type LogEntry, type RecordInput } from "../../supabase/functions/_shared/kb/kb.ts";
import type { BusinessSource } from "../../supabase/functions/_shared/registry/adapter.ts";
import type { BusinessEntity } from "../../supabase/functions/_shared/registry/schema.ts";

// ---- normalization
assert.equal(kbNameKey("ABC, Inc."), "ABC INC");
assert.equal(kbNameKey("abc inc"), "ABC INC");
assert.equal(kbNameKey("  Abc   INC. "), "ABC INC");
assert.equal(kbNameKey("A&B Co"), "A AND B CO");
assert.equal(kbNameKey("A & B Co"), "A AND B CO");
assert.equal(kbNameKey("O'Brien-Smith, LLC"), "OBRIEN SMITH LLC");
assert.equal(kbNameKey("Café Étoile LLC"), "CAFE ETOILE LLC");
assert.notEqual(kbNameKey("ACME INC"), kbNameKey("ACME INCORPORATED"), "legal suffixes are NOT normalized: that is a later tier's job");
assert.equal(staleAfterDays("active"), 90); assert.equal(staleAfterDays("dissolved"), 365); assert.equal(staleAfterDays("other"), 30);

// ---- in-memory store (mirrors kb_record_verified)
class MemStore implements KbStore {
  entities = new Map<string, KbEntity>(); aliases = new Map<string, string>(); logs: LogEntry[] = []; clock = Date.now(); n = 0;
  async findByName(state: string, key: string) { const id = this.aliases.get(`${state}|${key}`); return id ? this.entities.get(id) ?? null : null; }
  async record(i: RecordInput) {
    const k = `${i.registry_source_id}|${i.registry_entity_id}`;
    const old = [...this.entities.values()].find((e) => `${e.registry_source_id}|${e.registry_entity_id}` === k);
    const iso = new Date(this.clock).toISOString();
    const e: KbEntity = old
      ? { ...old, name: i.name, status: i.status, status_raw: i.status_raw, entity_type: i.entity_type, registration_date: i.registration_date, details: i.details, stale_after_days: i.stale_after_days, last_verified_at: iso, verification_count: old.verification_count + 1, last_outcome: "verified" }
      : { id: `e${++this.n}`, entity_kind: "employer", state: i.state, registry_source_id: i.registry_source_id, registry_entity_id: i.registry_entity_id, name: i.name, status: i.status, status_raw: i.status_raw, entity_type: i.entity_type, registration_date: i.registration_date, source_dataset: i.source_dataset, details: i.details, first_verified_at: iso, last_verified_at: iso, verification_count: 1, stale_after_days: i.stale_after_days, last_outcome: "verified" };
    this.entities.set(e.id, e);
    const conflicts: string[] = [];
    for (const a of i.alias_keys) { const ak = `${i.state}|${a.key}`; const ex = this.aliases.get(ak); if (!ex) this.aliases.set(ak, e.id); else if (ex !== e.id) conflicts.push(a.key); }
    return { entity: e, alias_conflicts: conflicts };
  }
  async log(entry: LogEntry) { this.logs.push(entry); return this.logs.length; }
}

const ent = (id: string, name: string, status: BusinessEntity["status"] = "active"): BusinessEntity => ({ entity_name: name, entity_id: id, status, status_raw: status === "active" ? "Good Standing" : "Delinquent", registration_date: "2010-01-01", entity_type: "DPC", state: "CO", source_dataset: "test/co", details: {} });
function fakeSource(handler: (q: string, mode: "exact" | "prefix") => BusinessEntity[] | "error"): BusinessSource & { calls: number } {
  const s = {
    id: "co-sos", label: "x", state: "CO", source_dataset: "test/co", kind: "socrata" as const, calls: 0,
    async search(q: { name?: string; limit?: number }, mode: "exact" | "prefix") {
      s.calls++;
      const r = handler(q.name ?? "", mode);
      return r === "error" ? { ok: false as const, source: "test/co", error: "http_503", detail: "down" } : { ok: true as const, records: r, meta: { source: "test/co", attempts: 1, ms: 1 } };
    },
  };
  return s;
}
const REG: Record<string, BusinessEntity> = { "ABC INC": ent("1001", "ABC INC."), "DAVITA INC": ent("1002", "DAVITA, INC.") };
const registry = fakeSource((q, mode) => {
  const k = kbNameKey(q);
  if (mode === "exact") return Object.values(REG).filter((e) => e.entity_name.toUpperCase() === q.toUpperCase());
  return Object.values(REG).filter((e) => e.entity_name.toUpperCase().startsWith(q.toUpperCase()) || (k.length >= 3 && kbNameKey(e.entity_name).startsWith(k)) && e.entity_name.toUpperCase().startsWith(q.toUpperCase()));
});

// ---- the headline scenario: ABC Inc listed by many candidates = ONE registry lookup, then cache hits
{
  const store = new MemStore(); registry.calls = 0;
  const deps = { store, registryFor: () => registry, now: () => store.clock };
  const first = await verifyBusiness(deps, { name: "ABC, Inc.", state: "co", caller: "t" });
  assert.equal(first.status, "verified"); assert.equal(first.cache_result, "miss"); assert.equal(first.from_cache, false); assert.equal(first.entity?.verification_count, 1);
  const callsAfterFirst = registry.calls; assert.ok(callsAfterFirst >= 1);
  for (const variant of ["ABC, Inc.", "ABC INC", "abc inc", "Abc Inc.", "ABC  INC", "ABC INC."]) {
    const r = await verifyBusiness(deps, { name: variant, state: "CO", caller: "t" });
    assert.equal(r.status, "verified", variant); assert.equal(r.cache_result, "hit", variant); assert.equal(r.from_cache, true); assert.equal(r.registry.queried, false);
  }
  assert.equal(registry.calls, callsAfterFirst, "cache hits must not touch the registry");
  assert.equal(store.entities.size, 1, "one entity no matter how many spellings");
  const hits = store.logs.filter((l) => l.cache_result === "hit").length;
  assert.equal(hits, 6); assert.equal(store.logs.length, 7, "every lookup is logged");

  // stale entry: re-asks the registry, updates last_verified_at, count 2
  store.clock += 91 * 86_400_000;
  const stale = await verifyBusiness(deps, { name: "ABC INC", state: "CO", caller: "t" });
  assert.equal(stale.cache_result, "stale"); assert.equal(stale.status, "verified"); assert.equal(stale.registry.queried, true); assert.equal(stale.entity?.verification_count, 2);
  // right after, fresh again
  assert.equal((await verifyBusiness(deps, { name: "ABC INC", state: "CO", caller: "t" })).cache_result, "hit");
  // force_refresh bypasses a fresh entry
  const forced = await verifyBusiness(deps, { name: "ABC INC", state: "CO", caller: "t", force_refresh: true });
  assert.equal(forced.cache_result, "bypass"); assert.equal(forced.entity?.verification_count, 3);
}

// ---- punctuation the registry files differently: found by the first-word step, only on an exact normalized match
{
  const store = new MemStore(); registry.calls = 0;
  const r = await verifyBusiness({ store, registryFor: () => registry, now: () => store.clock }, { name: "DaVita Inc", state: "CO", caller: "t" });
  assert.equal(r.status, "verified"); assert.equal(r.entity?.name, "DAVITA, INC."); assert.ok(registry.calls >= 2);
  // both the typed spelling and the registry's own spelling now hit
  assert.equal((await verifyBusiness({ store, registryFor: () => registry }, { name: "DAVITA, INC.", state: "CO", caller: "t" })).cache_result, "hit");
}

// ---- things that must NOT be accepted
{
  const store = new MemStore(); const deps = { store, registryFor: () => registry, now: () => store.clock };
  const sim = await verifyBusiness(deps, { name: "ABC Incorporated", state: "CO", caller: "t" });
  assert.equal(sim.status, "not_found", "a merely similar registered name is not a match"); assert.equal(store.entities.size, 0, "nothing cached on a miss");
  assert.equal(sim.manual_verification_required, true); assert.match(sim.message, /manual verification/i);
  const none = await verifyBusiness(deps, { name: "Zzqx Nonexistent LLC", state: "CO", caller: "t" });
  assert.equal(none.status, "not_found");

  // two ACTIVE entities with the same name: still ambiguous (a human decides)
  const dup = fakeSource((q, mode) => mode === "exact" ? [ent("1", "TWIN CO"), ent("2", "TWIN CO")] : []);
  const amb = await verifyBusiness({ store, registryFor: () => dup }, { name: "Twin Co", state: "CO", caller: "t" });
  assert.equal(amb.status, "ambiguous"); assert.equal(amb.candidates?.length, 2); assert.equal(store.entities.size, 0); assert.match(amb.message, /more than one is active/);
  // zero active (two dissolved predecessors): still ambiguous
  const dead = fakeSource((q, mode) => mode === "exact" ? [ent("1", "OLD CO", "dissolved"), ent("2", "OLD CO", "dissolved")] : []);
  const amb0 = await verifyBusiness({ store, registryFor: () => dead }, { name: "Old Co", state: "CO", caller: "t" });
  assert.equal(amb0.status, "ambiguous"); assert.match(amb0.message, /none is active/); assert.equal(store.entities.size, 0);
  // delinquent is NOT active: one delinquent + one merged is ambiguous
  const delinq = fakeSource((q, mode) => mode === "exact" ? [ent("1", "SLOW CO", "delinquent"), ent("2", "SLOW CO", "merged")] : []);
  assert.equal((await verifyBusiness({ store, registryFor: () => delinq }, { name: "Slow Co", state: "CO", caller: "t" })).status, "ambiguous");
  // RULE: exactly one active among same-name entities resolves automatically, is cached, and the passed-over entities are returned
  const wu = fakeSource((q, mode) => mode === "exact" ? [ent("19891097161", "WESTERN UNION FINANCIAL SERVICES, INC.", "merged"), ent("19991130081", "WESTERN UNION FINANCIAL SERVICES, INC.", "active")] : []);
  const res = await verifyBusiness({ store, registryFor: () => wu, now: () => store.clock }, { name: "Western Union Financial Services, Inc.", state: "CO", caller: "t" });
  assert.equal(res.status, "verified"); assert.equal(res.entity?.registry_entity_id, "19991130081"); assert.equal(res.manual_verification_required, false);
  assert.equal(res.resolution?.rule, "single_active_among_same_name"); assert.equal(res.resolution?.considered, 2); assert.deepEqual(res.resolution?.others.map((o) => o.registry_entity_id), ["19891097161"]);
  assert.match(res.message, /the one active entity was chosen/);
  assert.equal(store.entities.size, 1, "the resolved entity is cached"); assert.ok((store.entities.values().next().value as KbEntity).details.resolution, "the resolution is stored with the entity");
  assert.equal(store.logs[store.logs.length - 1].detail.resolved_by, "single_active_among_same_name", "the log records that the rule fired");
  assert.equal((await verifyBusiness({ store, registryFor: () => wu, now: () => store.clock }, { name: "WESTERN UNION FINANCIAL SERVICES INC", state: "CO", caller: "t" })).cache_result, "hit", "and the next spelling is a cache hit");
  store.entities.clear(); store.aliases.clear(); store.logs.length = 0;

  // name reservations / rejected filings are NOT entities (Connecticut lists them): an exact name that only exists as one is not found
  const resv = fakeSource((q, mode) => mode === "exact" ? [{ ...ent("7", "FUTURE CO LLC"), status: "other", status_raw: "Reserved" }, { ...ent("8", "FUTURE CO LLC"), status: "other", status_raw: "Rejected" }] : []);
  const rr = await verifyBusiness({ store, registryFor: () => resv }, { name: "Future Co LLC", state: "CO", caller: "t" });
  assert.equal(rr.status, "not_found", "a reserved / rejected name is not a registered business"); assert.equal(store.entities.size, 0);
  // ...and a reservation next to ONE real entity does not make it ambiguous
  const mix = fakeSource((q, mode) => mode === "exact" ? [{ ...ent("7", "MIX CO LLC"), status: "other", status_raw: "Expired Reservation" }, ent("8", "MIX CO LLC")] : []);
  const mx = await verifyBusiness({ store, registryFor: () => mix }, { name: "Mix Co LLC", state: "CO", caller: "t" });
  assert.equal(mx.status, "verified"); assert.equal(mx.entity?.registry_entity_id, "8"); assert.equal(mx.resolution, undefined, "no rule needed when only one real entity remains");
  store.entities.clear(); store.aliases.clear(); store.logs.length = 0;

  const down = fakeSource(() => "error");
  const inc = await verifyBusiness({ store, registryFor: () => down }, { name: "Anything Inc", state: "CO", caller: "t" });
  assert.equal(inc.status, "inconclusive"); assert.match(inc.message, /not a "not found"/);

  const big = fakeSource(() => Array.from({ length: 100 }, (_, i) => ent(String(i), `OTHER ${i}`)));
  const capped = await verifyBusiness({ store, registryFor: () => big }, { name: "Common Name Inc", state: "CO", caller: "t" });
  assert.equal(capped.status, "inconclusive"); assert.match(capped.message, /maximum number of results/);

  const tx = await verifyBusiness({ store, registryFor: () => registry }, { name: "ABC Inc", state: "TX", caller: "t" });
  assert.equal(tx.status, "no_automated_source"); assert.equal(tx.registry.queried, false); assert.equal(tx.manual_verification_required, true);
  // every one of these was logged with the right outcome
  assert.deepEqual(store.logs.map((l) => l.final_outcome), ["inconclusive", "inconclusive", "no_automated_source"], "every lookup after the last reset was logged with its outcome");
}

// ---- conflict: cache says A, registry now says B -> nothing overwritten
{
  const store = new MemStore(); store.clock = Date.now();
  const deps = { store, registryFor: () => registry, now: () => store.clock };
  await verifyBusiness(deps, { name: "ABC Inc", state: "CO", caller: "t" });
  const before = JSON.stringify([...store.entities.values()]);
  store.clock += 100 * 86_400_000;
  const changed = fakeSource((q, mode) => mode === "exact" ? [ent("9999", "ABC INC.")] : []);
  const c = await verifyBusiness({ store, registryFor: () => changed, now: () => store.clock }, { name: "ABC Inc", state: "CO", caller: "t" });
  assert.equal(c.status, "conflict"); assert.equal(JSON.stringify([...store.entities.values()]), before, "a conflict never rewrites the cache");
}
console.log("knowledge base: all offline scenarios passed (normalization, 1 registry lookup then hits, stale/bypass, punctuation step, rejects, conflict, logging)");
void findInRegistry;

// ---- Connecticut spec: placeholder / missing account numbers fall back to the unique Salesforce id; real ones are untouched
{
  const { SOCRATA_BUSINESS_SPECS } = await import("../../supabase/functions/_shared/registry/business-sources.ts");
  const ct = SOCRATA_BUSINESS_SPECS.find((s) => s.id === "ct-sots")!;
  const row = (acct: unknown, id: string, name = "X LLC") => ct.map({ id, accountnumber: acct, name, status: "Active", business_type: "LLC", date_registration: "2020-01-01T00:00:00.000" }, "data.ct.gov/n7gp-d28j")!;
  assert.equal(row("0527385", "001a").entity_id, "0527385");
  assert.equal(row("0000000", "001t000000sa77LAAQ", "WEBSTER BANK NATIONAL ASSOCIATION").entity_id, "SF-001t000000sa77LAAQ");
  assert.equal(row(undefined, "0018y000009oIojAAE").entity_id, "SF-0018y000009oIojAAE");
  assert.notEqual(row("0000000", "001a").entity_id, row("0000000", "001b").entity_id, "26 placeholder rows are 26 distinct entities, not one");
  console.log("connecticut spec: placeholder account numbers no longer collapse distinct entities");
}
