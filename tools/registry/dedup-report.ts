// Real before/after evidence that the Oregon and Pennsylvania dedup works: raw dataset rows vs distinct entities, for real
// queries against the live datasets.   node tools/registry/dedup-report.ts
import { SocrataClient, soqlUpperPrefix } from "../../supabase/functions/_shared/registry/socrata.ts";
import { makeSocrataBusinessSource, SOCRATA_BUSINESS_SPECS } from "../../supabase/functions/_shared/registry/business-sources.ts";

const PREFIXES = ["SMITH", "ACME", "GREEN", "JOHNSON PLUMBING"];
for (const spec of SOCRATA_BUSINESS_SPECS.filter((s) => s.groupBy)) {
  const src = makeSocrataBusinessSource(spec);
  const raw = new SocrataClient({ domain: spec.domain, datasetId: spec.datasetId });
  console.log(`\n=== ${spec.state} ${src.source_dataset}  (${spec.label})`);
  const total = await raw.count(); const totalEnt = await raw.count(undefined, spec.idField);
  if (total.ok && totalEnt.ok) console.log(`whole dataset: ${total.count.toLocaleString()} raw rows -> ${totalEnt.count.toLocaleString()} distinct ${spec.idField} (${(total.count / totalEnt.count).toFixed(2)} rows per entity)`);

  console.log("\nname-prefix queries (what a lookup sees): raw rows vs entities");
  for (const p of PREFIXES) {
    const e = await src.dedupEvidence!(p);
    if (e.ok) console.log(`  prefix "${p}": ${String(e.raw_rows).padStart(6)} raw rows -> ${String(e.entities).padStart(6)} entities   (naive row count overstates by ${(e.raw_rows / Math.max(e.entities, 1)).toFixed(2)}x)`);
    else console.log(`  prefix "${p}": ${e.error}`);
  }

  // one concrete business, row by row
  const probe = await raw.query<Record<string, string>>({ select: `${spec.idField},${spec.nameField}`, where: soqlUpperPrefix(spec.nameField, "SMITH"), order: `${spec.nameField}, ${spec.idField}`, limit: 1 });
  if (probe.ok && probe.rows[0]) {
    const id = probe.rows[0][spec.idField]; const name = probe.rows[0][spec.nameField];
    const rows = await raw.query<Record<string, string>>({ where: `${spec.idField} = '${id}'`, order: spec.idField, limit: 50 });
    const party = spec.state === "OR" ? "associated_name_type" : "party_type";
    console.log(`\none entity row by row: ${spec.idField}=${id} "${name}"`);
    if (rows.ok) {
      for (const r of rows.rows) console.log(`   raw row: ${party}=${r[party] ?? "(none)"} | ${[r.first_name, r.last_name].filter(Boolean).join(" ") || "-"} | ${[r.address ?? r.address_line1, r.city].filter(Boolean).join(", ")}`);
      const d = await src.search({ entity_id: id, limit: 50 }, "exact");
      console.log(`   => ${rows.rows.length} raw row(s) in the dataset, adapter returns ${d.ok ? d.records.length : "ERROR " + d.error} entity record(s):`);
      if (d.ok) console.log("     " + JSON.stringify(d.records[0]));
    }
  }

  // adapter-level: a real name lookup, meta shows raw vs deduped
  const r = await src.search({ name: "SMITH", limit: 100 }, "prefix");
  if (r.ok) console.log(`\nadapter search prefix "SMITH" (limit 100): records=${r.records.length} unique entity ids=${new Set(r.records.map((x) => x.entity_id)).size}  meta.raw_rows=${r.meta.raw_rows} meta.entities=${r.meta.entities}`);
}
