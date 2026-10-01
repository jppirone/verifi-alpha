// Before/after parity check for the database -> object-storage move. Runs the SAME battery of real queries (built from real parsed
// records) through the deployed registry-lookup restricted to one source:
//   record  = run the battery against whatever backs the source now, save the answers to <file>
//   compare = run it again and require every answer to be identical to the saved one
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=... node tools/registry/parity-check.ts <record|compare> <file> <source: ca-dca|mi-lara> <dataDir> <files...>
import fs from "node:fs";
import assert from "node:assert/strict";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";

const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
const [mode, outFile, sourceId, dataDir, ...files] = process.argv.slice(2);
if (!base || !anon || !token || !mode || !sourceId) { console.error("bad usage"); process.exit(2); }
const rows = files.flatMap((f) => { const t = fs.readFileSync(`${dataDir}/${f}`, sourceId === "ca-dca" ? "latin1" : "utf8"); return sourceId === "ca-dca" ? parseCaDcaTsv(t).rows : parseMichiganTsv(t).rows; });

const battery: Array<Record<string, unknown>> = [];
const step = Math.floor(rows.length / 40);
for (let i = 0; i < rows.length; i += step) {
  const r = rows[i];
  battery.push({ license_number: r.record.license_number });
  battery.push(r.first_name && r.last_name ? { first_name: r.first_name, last_name: r.last_name } : { business_name: r.record.license_holder_name });
  if (r.first_name && r.last_name && battery.length % 6 === 0) battery.push({ name: `${r.first_name} ${r.last_name}` });
}
battery.push({ first_name: "Zzqxv", last_name: "Plmnbvq" }, { license_number: "NO-SUCH-NUMBER-0000" });

async function ask(q: Record<string, unknown>) {
  const res = await fetch(`${base}/functions/v1/registry-lookup`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ kind: "license", sources: [sourceId], limit: 50, staff_session_token: token, ...q }) });
  const j = await res.json();
  assert.ok(j.ok, JSON.stringify(j).slice(0, 300));
  const rep = j.reports.find((x: any) => x.source_id === sourceId);
  assert.ok(rep && rep.ok, `source ${sourceId} did not answer ok: ${JSON.stringify(j.reports)}`);
  return { kind: rep.kind, hits: j.hits.map((h: any) => h.record).sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) };
}

const answers: unknown[] = []; let kinds = new Set<string>(); let nonEmpty = 0;
for (const q of battery) { const a = await ask(q); kinds.add(a.kind); if (a.hits.length) nonEmpty++; answers.push({ q, hits: a.hits }); }
console.log(`${mode}: ${battery.length} queries, ${nonEmpty} with results, backing store reported by lookup = ${[...kinds].join(",")}`);
if (mode === "record") fs.writeFileSync(outFile, JSON.stringify(answers));
else {
  const before = JSON.parse(fs.readFileSync(outFile, "utf8"));
  let diff = 0;
  // Postgres jsonb re-orders object keys; Parquet keeps insertion order. Same data, different key order, so compare canonically.
  const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const norm = (hits: any[]) => hits.map((h) => JSON.stringify(canon(h))).sort();
  answers.forEach((a: any, i: number) => { if (JSON.stringify(norm(a.hits)) !== JSON.stringify(norm(before[i].hits))) { diff++; if (diff <= 3) console.log("DIFF", JSON.stringify(a.q), "before", before[i].hits.length, "after", a.hits.length); } });
  console.log(diff === 0 ? `PARITY: all ${battery.length} answers identical before and after the move` : `PARITY FAILED: ${diff} of ${battery.length} answers differ`);
  process.exitCode = diff === 0 ? 0 : 1;
}
