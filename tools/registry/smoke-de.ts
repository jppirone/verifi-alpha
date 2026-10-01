// Live check of the Delaware DPR roster source plus the status mapping for every distinct license_status the dataset publishes.
import { socrataLicenseSources } from "../../supabase/functions/_shared/registry/license-sources.ts";
import { normalizeLicenseStatus } from "../../supabase/functions/_shared/registry/normalize.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";

const s = socrataLicenseSources().find((x) => x.id === "de-dpr")!;
for (const q of [{ first_name: "Mark", last_name: "Schlangel" }, { business_name: "Tammy Nails" }, { license_number: "M9-0012482" }, { name: "Zzqx Plm" }]) {
  const r = await s.search({ ...q, limit: 2 }, "exact");
  console.log(JSON.stringify(q), r.ok ? `records=${r.records.length}` : JSON.stringify(r));
  if (r.ok && r.records[0]) { console.log("  " + JSON.stringify(r.records[0])); const p = licenseProblems(r.records[0]); if (p.length) console.log("  SCHEMA PROBLEMS", p); }
}
const rows = await fetch("https://data.delaware.gov/resource/pjnv-eaih.json?$select=license_status,count(*)%20as%20n&$group=license_status&$order=n%20desc&$limit=40").then((r) => r.json());
console.log("\nDelaware license_status -> normalized");
for (const x of rows) console.log(`  ${String(x.license_status).padEnd(30)} ${String(x.n).padStart(7)} -> ${normalizeLicenseStatus(x.license_status)}`);
