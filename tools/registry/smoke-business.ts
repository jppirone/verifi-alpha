import { socrataBusinessSources } from "../../supabase/functions/_shared/registry/business-sources.ts";
import { businessProblems } from "../../supabase/functions/_shared/registry/schema.ts";
const names: Record<string, string> = { "co-sos": "CROCS, INC.", "ny-dos": "BUTCHY'S WINE & SPIRITS, INC.", "ct-sots": "YALE & TOWNE SPE, LLC", "or-sos": "UNITED METHODIST CHURCH, OREGON CITY, OREGON", "pa-dos": "Macro, Inc.", "tx-cpa": "TEXAS INSTRUMENTS INCORPORATED" };
for (const s of socrataBusinessSources()) {
  const t = Date.now();
  const r = await s.search({ name: names[s.id], limit: 5 }, "exact");
  console.log(`\n== ${s.id} (${s.source_dataset}) ${Date.now() - t}ms`);
  if (!r.ok) { console.log("FAIL", JSON.stringify(r)); continue; }
  console.log("meta", JSON.stringify(r.meta), "records", r.records.length);
  for (const rec of r.records.slice(0, 2)) { console.log(JSON.stringify(rec)); const p = businessProblems(rec); if (p.length) console.log("SCHEMA PROBLEMS", p); }
}
