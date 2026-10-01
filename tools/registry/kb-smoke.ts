// Runs the KB's registry-find step against the REAL Colorado registry for a list of well-known employers and prints what it decides.
import { socrataBusinessSources } from "../../supabase/functions/_shared/registry/business-sources.ts";
import { findInRegistry, kbNameKey } from "../../supabase/functions/_shared/kb/kb.ts";
const co = socrataBusinessSources().find((s) => s.id === "co-sos")!;
for (const n of process.argv.slice(2)) {
  const r = await findInRegistry(co, n);
  const d = r.kind === "match" ? `MATCH ${r.entity.entity_id} "${r.entity.entity_name}" ${r.entity.status_raw} ${r.entity.entity_type}` : r.kind === "ambiguous" ? `AMBIGUOUS x${r.matches.length}: ${r.matches.map((m) => m.entity_id + " " + m.status_raw).join(", ")}` : r.kind === "inconclusive" ? `INCONCLUSIVE ${r.reason}` : "NONE";
  console.log(`${n.padEnd(42)} key=${kbNameKey(n).padEnd(40)} -> ${d}  [${r.calls} registry call(s), ${r.ms} ms]`);
}
