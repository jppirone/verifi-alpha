// Unit test for the manual-verification summary (Part 3): every way a lookup can end must say plainly what staff should do.
import assert from "node:assert/strict";
import { summarizeVerification } from "../../supabase/functions/_shared/registry/verification.ts";
import type { SourceReport } from "../../supabase/functions/_shared/registry/lookup.ts";

const rep = (id: string, o: Partial<SourceReport> = {}): SourceReport => ({ source_id: id, label: id, state: "CO", kind: "socrata", source_dataset: id, ok: true, count: 0, ms: 1, ...o });
const covered = ["CA", "CO", "CT", "DE", "IL", "MI", "NY", "OR", "PA", "WA"];

// 1. hit, everything fine
let v = summarizeVerification({ hitCount: 1, reports: [rep("co-dora", { count: 1 })], notLoaded: [], coveredStates: covered });
assert.equal(v.status, "found"); assert.equal(v.manual_verification_required, false);

// 2. sources searched fine, nothing matched -> explicit "not found, verify manually", never a silent empty
v = summarizeVerification({ hitCount: 0, reports: [rep("co-dora"), rep("ct-dcp")], notLoaded: [], coveredStates: covered });
assert.equal(v.status, "not_found_manual_verification_required"); assert.equal(v.manual_verification_required, true);
assert.match(v.message, /does not mean the record does not exist/); assert.match(v.message, /manual verification/i);

// 3. Florida asked for: no source loaded for FL -> no automated source, says so by state
v = summarizeVerification({ hitCount: 0, reports: [], notLoaded: [{ source_id: "fl-sunbiz", state: "FL" }, { source_id: "fl-doh", state: "FL" }], requestedStates: ["fl"], coveredStates: covered });
assert.equal(v.status, "no_automated_source_manual_verification_required"); assert.deepEqual(v.states_without_automated_coverage, ["FL"]);
assert.match(v.message, /No automated source exists for FL/); assert.deepEqual(v.not_loaded_sources, ["fl-sunbiz", "fl-doh"]);

// 4. nothing matched and one source failed -> inconclusive, not "not found"
v = summarizeVerification({ hitCount: 0, reports: [rep("co-dora"), rep("il-idfpr", { ok: false, error: "source_timeout" })], notLoaded: [], coveredStates: covered });
assert.equal(v.status, "inconclusive_manual_verification_required"); assert.deepEqual(v.failed_sources, [{ source_id: "il-idfpr", error: "source_timeout" }]);
assert.match(v.message, /not a "not found"/);

// 5. found in CO but FL was also requested -> found, yet manual verification still required for FL
v = summarizeVerification({ hitCount: 1, reports: [rep("co-sos", { count: 1 })], notLoaded: [{ source_id: "fl-sunbiz", state: "FL" }], requestedStates: ["CO", "FL"], coveredStates: covered });
assert.equal(v.status, "found"); assert.equal(v.manual_verification_required, true); assert.deepEqual(v.states_without_automated_coverage, ["FL"]);

// 6. every searched source "skipped" (cannot answer this kind of query) is not the same as searched
v = summarizeVerification({ hitCount: 0, reports: [rep("wa-doh", { skipped: "cannot search by business name" })], notLoaded: [], coveredStates: covered });
assert.equal(v.status, "no_automated_source_manual_verification_required"); assert.equal(v.searched_sources.length, 0); assert.equal(v.skipped_sources.length, 1);

// 7. unrequested states: message names the coverage so "no match" is never read as "all states checked"
v = summarizeVerification({ hitCount: 0, reports: [rep("co-dora")], notLoaded: [], coveredStates: covered });
assert.match(v.message, /Automated coverage is limited to CA, CO, CT/);
console.log("verification summary: 7 scenarios passed");

// 8. a source that returned the maximum number of records says so: staff must not read a capped list as the complete list
v = summarizeVerification({ hitCount: 50, reports: [rep("ca-dca", { count: 50, truncated: true })], notLoaded: [], coveredStates: covered });
assert.deepEqual(v.truncated_sources, ["ca-dca"]); assert.match(v.message, /maximum number of results/);
console.log("verification summary: truncation scenario passed");
