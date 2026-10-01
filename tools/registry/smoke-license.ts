import { socrataLicenseSources } from "../../supabase/functions/_shared/registry/license-sources.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";
const qs: Record<string, any[]> = {
  "co-dora": [{ name: "Hilliary Lucido" }, { license_number: "711991" }],
  "ct-dcp": [{ name: "Samantha Wilson" }, { license_number: "70.013734" }],
  "il-idfpr": [{ business_name: "NATIONAL UNIVERSITY OF HEALTH SCIENCES" }, { license_number: "225000001" }],
  "wa-doh": [{ name: "Rocky Buckham" }, { license_number: "RN.RN.61687583.MSL" }],
  "wa-lni": [{ business_name: "!ECO STAR C G CONSTRUCTION LLC" }, { name: "Carlos Guerrero Martinez" }],
  "tx-bon-rn": [{ name: "Maria Garcia" }, { license_number: "681109" }],
  "tx-bon-vn": [{ name: "John Smith" }, { license_number: "11080" }],
  "tx-trec": [{ name: "John Smith" }, { license_number: "450504-SA" }],
  "ny-dos-re": [{ name: "John Smith" }, { license_number: "10401235308" }],
  "ny-dos-appearance": [{ name: "Maria Garcia" }, { license_number: "AEC-17-03268" }],
  "ny-dos-appraiser": [{ name: "Rohit Sarin" }, { license_number: "45000047061" }],
  "or-bcd": [{ name: "James Smith" }, { license_number: "24196J" }],
  "or-ccb": [{ name: "Pedro Magallan" }, { license_number: "242649" }],
  "wa-cpa": [{ name: "Mark Ruzicka" }, { license_number: "50762" }],
};
for (const s of socrataLicenseSources()) {
  for (const q of qs[s.id] ?? []) { // sources without an entry here (de-dpr) are covered by smoke-de.ts
    const t = Date.now();
    const r = await s.search({ ...q, limit: 3 }, "exact");
    console.log(`\n== ${s.id} ${JSON.stringify(q)} ${Date.now() - t}ms`);
    if (!r.ok) { console.log("FAIL", JSON.stringify(r)); continue; }
    console.log("records", r.records.length, "attempts", r.meta.attempts);
    for (const rec of r.records.slice(0, 2)) { console.log(JSON.stringify(rec)); const p = licenseProblems(rec); if (p.length) console.log("SCHEMA PROBLEMS", p); }
  }
}
