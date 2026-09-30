import { socrataLicenseSources } from "../../supabase/functions/_shared/registry/license-sources.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";
const qs: Record<string, any[]> = {
  "co-dora": [{ name: "Hilliary Lucido" }, { license_number: "711991" }],
  "ct-dcp": [{ name: "Samantha Wilson" }, { license_number: "70.013734" }],
  "il-idfpr": [{ business_name: "NATIONAL UNIVERSITY OF HEALTH SCIENCES" }, { license_number: "225000001" }],
  "wa-doh": [{ name: "Rocky Buckham" }, { license_number: "RN.RN.61687583.MSL" }],
  "wa-lni": [{ business_name: "!ECO STAR C G CONSTRUCTION LLC" }, { name: "Carlos Guerrero Martinez" }],
};
for (const s of socrataLicenseSources()) {
  for (const q of qs[s.id]) {
    const t = Date.now();
    const r = await s.search({ ...q, limit: 3 }, "exact");
    console.log(`\n== ${s.id} ${JSON.stringify(q)} ${Date.now() - t}ms`);
    if (!r.ok) { console.log("FAIL", JSON.stringify(r)); continue; }
    console.log("records", r.records.length, "attempts", r.meta.attempts);
    for (const rec of r.records.slice(0, 2)) { console.log(JSON.stringify(rec)); const p = licenseProblems(rec); if (p.length) console.log("SCHEMA PROBLEMS", p); }
  }
}
