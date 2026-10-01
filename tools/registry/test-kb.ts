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
      ? { ...old, name: i.name, status: i.status, status_raw: i.status_raw, entity_type: i.entity_type, registration_date: i.registration_date, details: i.details, stale_after_days: i.stale_after_days, source_completeness: i.source_completeness, last_verified_at: iso, verification_count: old.verification_count + 1, last_outcome: "verified" }
      : { id: `e${++this.n}`, entity_kind: "employer", state: i.state, registry_source_id: i.registry_source_id, registry_entity_id: i.registry_entity_id, name: i.name, status: i.status, status_raw: i.status_raw, entity_type: i.entity_type, registration_date: i.registration_date, source_dataset: i.source_dataset, details: i.details, first_verified_at: iso, last_verified_at: iso, verification_count: 1, stale_after_days: i.stale_after_days, last_outcome: "verified", source_completeness: i.source_completeness };
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

// ---- source completeness: full_history (CO, CT) vs active_only (NY, OR); Pennsylvania stays off
{
  const { KB_SOURCE_PROFILES } = await import("../../supabase/functions/_shared/kb/kb.ts");
  assert.deepEqual(Object.fromEntries(Object.entries(KB_SOURCE_PROFILES).map(([k, v]) => [k, v.completeness])), { CO: "full_history", CT: "full_history", NY: "active_only", OR: "active_only", PA: "registrations_unflagged" });

  const mk = (stateCode: string, srcId: string, handler: Parameters<typeof fakeSource>[0]) => { const s = fakeSource(handler); (s as { id: string }).id = srcId; return s; };
  const nyReg = mk("NY", "ny-dos", (q, mode) => (mode === "exact" ? q.toUpperCase() === "ACME WIDGETS INC" : "ACME WIDGETS INC".startsWith(q.toUpperCase())) ? [{ ...ent("N1", "ACME WIDGETS INC"), state: "NY", status_raw: null }] : []);

  const store = new MemStore(); const deps = { store, registryFor: () => nyReg, now: () => store.clock };
  const v = await verifyBusiness(deps, { name: "Acme Widgets, Inc.", state: "NY", caller: "t" });
  assert.equal(v.status, "verified"); assert.equal(v.entity?.source_completeness, "active_only", "the entity is tagged with its source's completeness");
  assert.equal(v.registry.completeness, "active_only"); assert.match(v.message, /active entities only/);
  assert.equal(store.logs[0].source_completeness, "active_only", "and so is the log row");
  const hit = await verifyBusiness(deps, { name: "ACME WIDGETS INC", state: "NY", caller: "t" });
  assert.equal(hit.cache_result, "hit"); assert.equal(hit.entity?.source_completeness, "active_only"); assert.match(hit.message, /active entities only/);
  assert.equal(store.logs[1].source_completeness, "active_only");

  // a miss in an active-only registry means something different: it says so
  const miss = await verifyBusiness(deps, { name: "Gone Co LLC", state: "NY", caller: "t" });
  assert.equal(miss.status, "not_found"); assert.match(miss.message, /No ACTIVE NY registry entity/); assert.match(miss.message, /dissolved, merged or been withdrawn/);
  assert.equal(miss.disappeared_from_active_register, undefined, "never verified before, so nothing to say it disappeared");
  assert.equal(store.logs[2].detail.active_only_registry, true);

  // previously verified, now absent from the active list -> flagged as most likely closed
  store.clock += 100 * 86_400_000;
  const nyGone = mk("NY", "ny-dos", () => []);
  const gone = await verifyBusiness({ store, registryFor: () => nyGone, now: () => store.clock }, { name: "Acme Widgets Inc", state: "NY", caller: "t" });
  assert.equal(gone.status, "not_found"); assert.equal(gone.cache_result, "stale"); assert.equal(gone.disappeared_from_active_register, true);
  assert.match(gone.message, /most likely closed since/); assert.equal(store.logs[3].detail.disappeared_from_active_register, true);

  // the same absence in a FULL-history registry carries no such claim
  const coReg = fakeSource(() => []); const coStore = new MemStore();
  const coMiss = await verifyBusiness({ store: coStore, registryFor: () => coReg }, { name: "Nobody Inc", state: "CO", caller: "t" });
  assert.equal(coMiss.status, "not_found"); assert.doesNotMatch(coMiss.message, /active entities only/); assert.equal(coMiss.registry.completeness, "full_history");
  assert.equal(coMiss.disappeared_from_active_register, undefined);

  // a state with no source at all still says so (Texas)
  const txReg = fakeSource(() => [ent("T1", "ANY CO INC")]);
  const tx = await verifyBusiness({ store: new MemStore(), registryFor: () => txReg }, { name: "Any Co Inc", state: "TX", caller: "t" });
  assert.equal(tx.status, "no_automated_source"); assert.equal(txReg.calls, 0);
  console.log("source completeness: tagged on entity + log, active-only wording, disappeared-from-active-list signal");
}

// ---- Pennsylvania (registrations_unflagged): a hit is "registered", status UNKNOWN (never active), 30-day re-check, operating status stays a staff call
{
  const { BUSINESS_STATUSES, businessProblems } = await import("../../supabase/functions/_shared/registry/schema.ts");
  const { SOCRATA_BUSINESS_SPECS } = await import("../../supabase/functions/_shared/registry/business-sources.ts");
  assert.ok(BUSINESS_STATUSES.includes("unknown"));

  // the ADAPTER: every Pennsylvania row maps to status "unknown", never "active", and the entity still passes the common schema
  const paSpec = SOCRATA_BUSINESS_SPECS.find((s) => s.id === "pa-dos")!;
  const row = paSpec.map({ filing_number: "0003810600", business_name: "Smith 2 Twist Llc", typeofbusinessregistration: "Domestic Limited Liability Company", creationdate: "2008-05-09T00:00:00.000" }, "data.pa.gov/xvd7-5r2c")!;
  assert.equal(row.status, "unknown"); assert.equal(row.status_raw, null); assert.deepEqual(businessProblems(row), []);
  assert.match(String(row.details.status_basis), /no longer in operation/); assert.equal(row.details.source_completeness, "registrations_unflagged");
  assert.equal(paSpec.map({ filing_number: "1", business_name: "X", creationdate: "1753-01-01T00:00:00.000" }, "s")!.registration_date, null, "the 1753-01-01 placeholder is not a registration date");
  // the other two status-less registries are unchanged: NY and OR genuinely list active entities only
  for (const id of ["ny-dos", "or-sos"]) { const sp = SOCRATA_BUSINESS_SPECS.find((s) => s.id === id)!; assert.equal(sp.map({ dos_id: "1", current_entity_name: "X", registry_number: "1", business_name: "X" }, "s")!.status, "active", id); }

  const paReg = fakeSource((q, mode) => (mode === "exact" ? q.toUpperCase() === "DEAD STORES, INC." : "DEAD STORES, INC.".startsWith(q.toUpperCase())) ? [{ ...ent("P1", "The Dead Stores, Inc."), name: "x", state: "PA", status: "unknown", status_raw: null }] : []);
  paReg.search = async (q: { name?: string }, mode: "exact" | "prefix") => ({ ok: true as const, records: (mode === "exact" ? (q.name ?? "").toUpperCase() === "THE DEAD STORES, INC." : "THE DEAD STORES, INC.".startsWith((q.name ?? "").toUpperCase())) ? [{ ...ent("0001234567", "The Dead Stores, Inc."), state: "PA", status: "unknown" as const, status_raw: null }] : [], meta: { source: "pa", attempts: 1, ms: 1 } });
  const store = new MemStore(); const deps = { store, registryFor: () => paReg, now: () => store.clock };
  const hit1 = await verifyBusiness(deps, { name: "The Dead Stores Inc", state: "PA", caller: "t" });
  assert.equal(hit1.status, "verified"); assert.equal(hit1.manual_verification_required, false, "existence is verified");
  assert.equal(hit1.entity?.status, "unknown", "never active"); assert.notEqual(hit1.entity?.status, "active");
  assert.equal(hit1.entity?.stale_after_days, 30); assert.equal(hit1.entity?.source_completeness, "registrations_unflagged");
  assert.equal(hit1.operating_status, "unknown"); assert.equal(hit1.operating_status_confirmation_required, true, "operating status stays a staff confirmation");
  assert.match(hit1.message, /registered/); assert.match(hit1.message, /UNKNOWN/); assert.match(hit1.message, /no longer in operation/); assert.match(hit1.message, /status not published/);
  assert.equal(store.logs[0].source_completeness, "registrations_unflagged");
  // the cached answer says the same thing
  const hit2 = await verifyBusiness(deps, { name: "THE DEAD STORES, INC.", state: "PA", caller: "t" });
  assert.equal(hit2.cache_result, "hit"); assert.equal(hit2.operating_status, "unknown"); assert.equal(hit2.operating_status_confirmation_required, true); assert.match(hit2.message, /no longer in operation/);
  // 30-day window: still a hit at 29 days, re-checked at 31
  store.clock += 29 * 86_400_000; assert.equal((await verifyBusiness(deps, { name: "The Dead Stores Inc", state: "PA", caller: "t" })).cache_result, "hit");
  store.clock += 2 * 86_400_000; const re = await verifyBusiness(deps, { name: "The Dead Stores Inc", state: "PA", caller: "t" });
  assert.equal(re.cache_result, "stale"); assert.equal(re.registry.queried, true); assert.equal(re.entity?.verification_count, 2);

  // a miss: monthly-publication + defunct-kept wording, never the "no longer active" wording of an active-only registry
  const miss = await verifyBusiness({ store: new MemStore(), registryFor: () => fakeSource(() => []) }, { name: "Nobody Co", state: "PA", caller: "t" });
  assert.equal(miss.status, "not_found"); assert.match(miss.message, /keeps defunct businesses/); assert.match(miss.message, /monthly/); assert.doesNotMatch(miss.message, /ACTIVE/);

  // same-name entities: PA rows are all "unknown", so the single-active rule can never fire; the message does not claim "none is active"
  const dup = fakeSource((q, mode) => mode === "exact" ? [{ ...ent("1", "TWIN CO"), state: "PA", status: "unknown" as const, status_raw: null }, { ...ent("2", "TWIN CO"), state: "PA", status: "unknown" as const, status_raw: null }] : []);
  const amb = await verifyBusiness({ store: new MemStore(), registryFor: () => dup }, { name: "Twin Co", state: "PA", caller: "t" });
  assert.equal(amb.status, "ambiguous"); assert.match(amb.message, /publishes no status/); assert.doesNotMatch(amb.message, /none is active/);

  // operating status elsewhere: the registry's own status maps honestly
  const { operatingStatus } = await import("../../supabase/functions/_shared/kb/kb.ts");
  assert.equal(operatingStatus("active"), "active_per_registry"); assert.equal(operatingStatus("dissolved"), "not_active"); assert.equal(operatingStatus("merged"), "not_active");
  assert.equal(operatingStatus("delinquent"), "unknown"); assert.equal(operatingStatus("unknown"), "unknown");
  const co = await verifyBusiness({ store: new MemStore(), registryFor: () => fakeSource((q, mode) => mode === "exact" ? [ent("9", "LIVE CO INC")] : []) }, { name: "Live Co Inc", state: "CO", caller: "t" });
  assert.equal(co.operating_status, "active_per_registry"); assert.equal(co.operating_status_confirmation_required, false);
  console.log("pennsylvania: status unknown (never active), 30-day window, operating status stays staff-confirmed, honest wording, adapter fixed");
}

// ---- placeholder date: SQL Server's minimum date is "no date", never a real registration date
{
  const { isoDate } = await import("../../supabase/functions/_shared/registry/normalize.ts");
  assert.equal(isoDate("1753-01-01T00:00:00.000"), null); assert.equal(isoDate("0001-01-01T00:00:00.000"), null);
  assert.equal(isoDate("1753-01-02T00:00:00.000"), "1753-01-02"); assert.equal(isoDate("1800-02-16T00:00:00.000"), "1800-02-16");
  console.log("dates: 1753-01-01 placeholder -> null; real old dates kept");
}
