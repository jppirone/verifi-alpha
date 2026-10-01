// Offline tests: employer state parsing, the item patch built from a KB response, the gate, and the guarantee that only Pennsylvania-style
// (status-less registry) results route to staff confirmation.
import assert from "node:assert/strict";
import { employerStateFromLocation, employerFromWorkHistory, employerCheckFromKb, notCheckedPatch, mergeAutomatedCheck, blocksConfirmed } from "../../supabase/functions/_shared/kb/queue-check.ts";
import { verifyBusiness, operatingStatus, type KbEntity, type KbStore, type LogEntry, type RecordInput } from "../../supabase/functions/_shared/kb/kb.ts";
import type { BusinessEntity } from "../../supabase/functions/_shared/registry/schema.ts";
import type { BusinessSource } from "../../supabase/functions/_shared/registry/adapter.ts";

// ---- state from a free-text location
const cases: Array<[string | null, string | null]> = [
  ["York, PA", "PA"], ["York, Pennsylvania", "PA"], ["York, Pennsylvania 17401", "PA"], ["York, PA 17401", "PA"], ["Pittsburgh, PA, USA", "PA"], ["Pittsburgh, PA, United States", "PA"],
  ["Philadelphia PA", "PA"], ["Denver, CO", "CO"], ["Hartford, Connecticut", "CT"], ["Albany, NY", "NY"], ["New York, New York", "NY"], ["Portland, OR", "OR"], ["Portland, Oregon", "OR"],
  ["Washington, DC", "DC"], ["Seattle, Washington", "WA"], ["San Francisco, CA, USA", "CA"],
  ["Remote", null], ["Hybrid", null], ["", null], [null, null], ["Philadelphia", null], ["Washington", null], ["Springfield", null], ["London, UK", null], ["Toronto, Ontario", null],
  ["Phoenix, ARIZONA", "AZ"], ["St. Louis, MO", "MO"], ["Portland, or", null],
];
for (const [loc, want] of cases) assert.equal(employerStateFromLocation(loc), want, `location ${JSON.stringify(loc)}`);
assert.deepEqual(employerFromWorkHistory({ company: "Bon-Ton", employer_name_override: "The Bon-Ton Stores, Inc.", location: "Remote", employer_location_override: "York, PA" }), { name: "The Bon-Ton Stores, Inc.", state: "PA" }, "overrides win");
assert.deepEqual(employerFromWorkHistory({ company: "Acme", employer_name_override: null, location: "Denver, CO", employer_location_override: null }), { name: "Acme", state: "CO" });
assert.deepEqual(employerFromWorkHistory({ company: "Acme", employer_name_override: null, location: "Denver", employer_location_override: null }), { name: "Acme", state: null });

// ---- not-checked patches
const nc = notCheckedPatch("no_state"); assert.equal(nc.operating_confirmation_required, false); assert.equal(nc.operating_status, null); assert.match(nc.automated_check_line, /no employer state/);
assert.equal((nc.employer_check as { status: string }).status, "not_checked");

// ---- a KB response -> item patch; only a status-less registry routes to confirmation
const ent = (id: string, name: string, status: BusinessEntity["status"], raw: string | null = null): BusinessEntity => ({ entity_name: name, entity_id: id, status, status_raw: raw, registration_date: "2000-01-01", entity_type: "Corp", state: "XX", source_dataset: "t", details: {} });
class Mem implements KbStore {
  e = new Map<string, KbEntity>(); a = new Map<string, string>(); n = 0;
  async findByName(s: string, k: string) { const id = this.a.get(s + "|" + k); return id ? this.e.get(id) ?? null : null; }
  async record(i: RecordInput) { const now = new Date().toISOString(); const x: KbEntity = { id: "e" + ++this.n, entity_kind: "employer", state: i.state, registry_source_id: i.registry_source_id, registry_entity_id: i.registry_entity_id, name: i.name, status: i.status, status_raw: i.status_raw, entity_type: i.entity_type, registration_date: i.registration_date, source_dataset: i.source_dataset, details: i.details, first_verified_at: now, last_verified_at: now, verification_count: 1, stale_after_days: i.stale_after_days, last_outcome: "verified", source_completeness: i.source_completeness }; this.e.set(x.id, x); for (const al of i.alias_keys) this.a.set(i.state + "|" + al.key, x.id); return { entity: x, alias_conflicts: [] }; }
  async log(_l: LogEntry) { return 1; }
}
const src = (rows: BusinessEntity[]): BusinessSource => ({ id: "x", label: "x", state: "XX", source_dataset: "t", kind: "socrata", async search(q, mode) { const k = (q.name ?? "").toUpperCase(); return { ok: true as const, records: rows.filter((r) => (mode === "exact" ? r.entity_name.toUpperCase() === k : r.entity_name.toUpperCase().startsWith(k))), meta: { source: "t", attempts: 1, ms: 1 } }; } });
async function route(state: string, rows: BusinessEntity[], name: string) { const r = await verifyBusiness({ store: new Mem(), registryFor: () => src(rows) }, { name, state, caller: "queue" }); return { r, p: employerCheckFromKb(r) }; }

// Pennsylvania-style (status unknown): routed
const pa = await route("PA", [ent("0002676881", "The Bon-ton Stores, Inc.", "unknown")], "The Bon-ton Stores, Inc.");
assert.equal(pa.r.status, "verified", "existence is resolved automatically"); assert.equal(pa.p.operating_confirmation_required, true); assert.equal(pa.p.operating_status, "unknown");
assert.equal((pa.p.employer_check as { status: string }).status, "verified", "and the item still records the employer as found");
assert.match(pa.p.automated_check_line, /OPERATING STATUS NEEDS STAFF CONFIRMATION/); assert.match(pa.p.automated_check_line, /Employer check \(PA registry\)/);

// every OTHER registry / status: NOT routed (Colorado, Connecticut, New York, Oregon behave exactly as before)
for (const [st, status, raw, label] of [["CO", "active", "Good Standing", "CO good standing"], ["CO", "delinquent", "Delinquent", "CO delinquent"], ["CO", "dissolved", "Voluntarily Dissolved", "CO dissolved"], ["CO", "pending", "Pending", "pending"], ["CO", "other", "Exists?", "other"],
  ["CT", "active", "Active", "CT active"], ["CT", "delinquent", "Noncompliant", "CT noncompliant"], ["CT", "merged", "Merged", "CT merged"], ["NY", "active", null, "NY (active-only)"], ["OR", "active", null, "OR (active-only)"]] as const) {
  const x = await route(st, [ent("1", "Acme Inc", status as BusinessEntity["status"], raw)], "Acme Inc");
  assert.equal(x.p.operating_confirmation_required, false, label); assert.equal(x.r.operating_status_confirmation_required, false, label + " (KB response)");
}
assert.equal(operatingStatus("delinquent"), "unknown", "the informational value is unchanged; only the routing flag was narrowed");

// not found / ambiguous / no source: nothing to route, existence not claimed
for (const [state, rows] of [["PA", []], ["TX", [ent("1", "Acme Inc", "unknown")]]] as const) { const x = await route(state, rows as BusinessEntity[], "Acme Inc"); assert.equal(x.p.operating_confirmation_required, false); assert.equal(x.p.operating_status, null); assert.notEqual((x.p.employer_check as { status: string }).status, "verified"); }

// ---- automated_check text merging is idempotent and preserves other text
assert.equal(mergeAutomatedCheck(null, "Employer check A"), "Employer check A");
assert.equal(mergeAutomatedCheck("Staff note\nEmployer check A", "Employer check B"), "Staff note\nEmployer check B");
assert.equal(mergeAutomatedCheck(mergeAutomatedCheck("x", "Employer check 1"), "Employer check 2"), "x\nEmployer check 2");

// ---- the gate
assert.equal(blocksConfirmed({ operating_confirmation_required: true, operating_resolution: null }, "Confirmed"), true, "flagged + unresolved: Confirmed is refused");
assert.equal(blocksConfirmed({ operating_confirmation_required: true, operating_resolution: "operating" }, "Confirmed"), false, "resolved: allowed");
assert.equal(blocksConfirmed({ operating_confirmation_required: true, operating_resolution: "not_operating" }, "Confirmed"), false);
assert.equal(blocksConfirmed({ operating_confirmation_required: true, operating_resolution: "undetermined" }, "Confirmed"), false);
for (const s of ["New", "In Progress", "Awaiting Response", "Needs Reconciliation", "Discrepancy", "Verification Not Possible", "Unable to Verify"]) assert.equal(blocksConfirmed({ operating_confirmation_required: true, operating_resolution: null }, s), false, s + " is never blocked");
assert.equal(blocksConfirmed({ operating_confirmation_required: false, operating_resolution: null }, "Confirmed"), false, "unflagged items are untouched");
assert.equal(blocksConfirmed({}, "Confirmed"), false); assert.equal(blocksConfirmed({ operating_confirmation_required: null }, "Confirmed"), false);
console.log("queue wiring: state parsing, KB->item patch, only status-less registries route to staff, text merge, Confirmed gate - all passed");
