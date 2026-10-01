// Proves every source returns the SAME record shape: field names, JS types and nullability. Pulls one real record from every live Socrata
// source (business and license), plus real parsed California DCA rows if a sample dir is given, and compares shapeSignature()s.
//   node tools/registry/shape-test.ts [<ca-dca dir with Psychology_full.xls>]
import fs from "node:fs";
import { socrataBusinessSources } from "../../supabase/functions/_shared/registry/business-sources.ts";
import { socrataLicenseSources } from "../../supabase/functions/_shared/registry/license-sources.ts";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { BUSINESS_SHAPE, LICENSE_SHAPE, businessProblems, licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";

const probe: Record<string, any> = {
  "co-sos": { name: "Google" }, "ny-dos": { name: "Google" }, "ct-sots": { name: "Yale" }, "or-sos": { name: "Nike" }, "pa-dos": { name: "Hershey" }, "tx-cpa": { name: "Dell" },
  "co-dora": { name: "Hilliary Lucido" }, "ct-dcp": { name: "Samantha Wilson" }, "il-idfpr": { business_name: "NATIONAL UNIVERSITY OF HEALTH SCIENCES" },
  "wa-doh": { name: "Rocky Buckham" }, "de-dpr": { first_name: "Mark", last_name: "Schlangel" }, "wa-lni": { business_name: "!ECO STAR C G CONSTRUCTION LLC" },
  "tx-bon-rn": { name: "Maria Garcia" }, "tx-bon-vn": { name: "John Smith" }, "tx-trec": { name: "John Smith" }, "ny-dos-re": { name: "John Smith" }, "ny-dos-appearance": { name: "Maria Garcia" },
  "or-bcd": { name: "James Smith" }, "or-ccb": { name: "Pedro Magallan" }, "wa-cpa": { name: "Mark Ruzicka" },
};
const rows: Array<{ id: string; kind: "business" | "license"; rec: Record<string, unknown>; problems: string[] }> = [];
for (const s of socrataBusinessSources()) {
  const r = await s.search({ ...probe[s.id], limit: 1 }, "prefix");
  if (!r.ok || !r.records[0]) { console.log("NO RECORD", s.id, JSON.stringify(r).slice(0, 200)); process.exitCode = 1; continue; }
  rows.push({ id: s.id, kind: "business", rec: r.records[0] as any, problems: businessProblems(r.records[0]) });
}
for (const s of socrataLicenseSources()) {
  const r = await s.search({ ...probe[s.id], limit: 1 }, "prefix");
  if (!r.ok || !r.records[0]) { console.log("NO RECORD", s.id, JSON.stringify(r).slice(0, 200)); process.exitCode = 1; continue; }
  rows.push({ id: s.id, kind: "license", rec: r.records[0] as any, problems: licenseProblems(r.records[0]) });
}
const dir = process.argv[2];
if (dir) {
  const { rows: ca } = parseCaDcaTsv(fs.readFileSync(`${dir}/Psychology_full.xls`, "latin1"));
  rows.push({ id: "ca-dca (file-ingested)", kind: "license", rec: ca[0].record as any, problems: licenseProblems(ca[0].record) });
}
// A nullable field (declared "string|null") holding null is the SAME shape as one holding a string; a bare typeof/null signature would
// call NY/OR/PA (which publish no status column, so status_raw is null) a different shape from CO. So: type = declared type when the actual value conforms.
const sigOf = (rec: Record<string, unknown>, decl: Record<string, string>) => Object.keys(rec).sort().map((k) => { const v = rec[k]; const ok = decl[k] === "object" ? (typeof v === "object" && v !== null && !Array.isArray(v)) : decl[k] === "string" ? typeof v === "string" : (typeof v === "string" || v === null); return k + ":" + (ok ? decl[k] : "MISMATCH(" + typeof v + ")"); }).join(" ");
for (const kind of ["business", "license"] as const) {
  const expect = kind === "business" ? BUSINESS_SHAPE : LICENSE_SHAPE;
  console.log(`\n=== ${kind}: declared shape = ${Object.keys(expect).length} fields: ${Object.keys(expect).join(", ")}`);
  const sigs = new Map<string, string[]>();
  for (const r of rows.filter((x) => x.kind === kind)) {
    const sig = sigOf(r.rec, expect as Record<string, string>);
    (sigs.get(sig) ?? sigs.set(sig, []).get(sig)!).push(r.id);
    const keys = Object.keys(r.rec).join(",");
    console.log(`${r.id.padEnd(24)} fields=${Object.keys(r.rec).length} keys_match_declared=${keys === Object.keys(expect).join(",")} schema_problems=${r.problems.length ? JSON.stringify(r.problems) : "none"}`);
  }
  console.log(`distinct shape signatures: ${sigs.size} (${[...sigs.values()].map((v) => v.join("+")).join(" | ")})`);
  if (sigs.size !== 1) process.exitCode = 1;
}
