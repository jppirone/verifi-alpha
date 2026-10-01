// Runs the KB's registry-find step against a REAL enabled registry for a list of employers and prints what it decides.
//   node tools/registry/kb-smoke.ts <STATE> "Name 1" "Name 2" ...
import { socrataBusinessSources } from "../../supabase/functions/_shared/registry/business-sources.ts";
import { KB_ENABLED_SOURCES, findInRegistry, kbNameKey } from "../../supabase/functions/_shared/kb/kb.ts";
const [state, ...names] = process.argv.slice(2);
const src = socrataBusinessSources().find((s) => s.id === KB_ENABLED_SOURCES[state.toUpperCase()])!;
for (const n of names) {
  const r = await findInRegistry(src, n);
  const d = r.kind === "match"
    ? `MATCH ${r.entity.entity_id} "${r.entity.entity_name}" ${r.entity.status_raw} ${r.entity.entity_type}${r.resolution ? `  [RESOLVED: 1 active of ${r.resolution.considered}; others: ${r.resolution.others.map((o) => o.registry_entity_id + " " + o.status_raw).join(", ")}]` : ""}`
    : r.kind === "ambiguous" ? `AMBIGUOUS x${r.matches.length}: ${r.matches.map((m) => m.entity_id + " " + m.status_raw).join(", ")}`
    : r.kind === "inconclusive" ? `INCONCLUSIVE ${r.reason}` : "NONE";
  console.log(`${n.padEnd(46)} -> ${d}  [${r.calls} call(s), ${r.ms} ms]`);
}
