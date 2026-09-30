// Parses the real downloaded California DCA files with the real parser and validates every record against the common schema.
//   node tools/registry/ca-parse-check.ts <dir-with-files> [file ...]
import fs from "node:fs";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";

const dir = process.argv[2]; const only = process.argv.slice(3);
const files = (only.length ? only : fs.readdirSync(dir).filter((f) => /\.xls$/i.test(f) && !/partial/.test(f)));
let total = 0, bad = 0;
for (const f of files) {
  const text = fs.readFileSync(`${dir}/${f}`, "latin1");
  const { rows, stats, header } = parseCaDcaTsv(text);
  const st: Record<string, number> = {}; let invalid = 0;
  for (const r of rows) { st[`${r.record.status_raw ?? "(blank)"} -> ${r.record.status}`] = (st[`${r.record.status_raw ?? "(blank)"} -> ${r.record.status}`] ?? 0) + 1; if (licenseProblems(r.record).length) invalid++; }
  total += rows.length; bad += invalid;
  console.log(`${f}: lines=${stats.lines} parsed=${stats.parsed} rejected=${stats.rejected} schemaInvalid=${invalid} keys=${new Set(rows.map((r) => r.record_key)).size}`);
  console.log(`   statuses: ${Object.entries(st).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
  if (stats.rejectedSamples.length) console.log(`   rejected samples: ${JSON.stringify(stats.rejectedSamples)}`);
  if (rows[0]) console.log(`   first: ${JSON.stringify(rows[0].record)}`);
}
console.log(`\nTOTAL parsed=${total} schemaInvalid=${bad}`);
