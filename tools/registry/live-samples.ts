// Live lookups, through the DEPLOYED registry-lookup, of real records taken from each newly loaded board / group: for each file it picks
// real holders spread through the file, looks each one up by name AND by license number, and prints what actually came back. A sample passes
// only if the exact source record is among the returned hits.
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=... node tools/registry/live-samples.ts <ca|mi> <dir> <perFile> <file...>
import fs from "node:fs";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";

const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
const [which, dir, perFileArg, ...files] = process.argv.slice(2);
if (!base || !anon || !token || !which || !dir) { console.error("bad usage"); process.exit(2); }
const perFile = Number(perFileArg) || 2;
const source = which === "ca" ? "ca-dca" : "mi-lara";

async function ask(q: Record<string, unknown>) {
  const t = Date.now();
  const res = await fetch(`${base}/functions/v1/registry-lookup`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ kind: "license", sources: [source], states: [source === "ca-dca" ? "CA" : "MI"], limit: 50, staff_session_token: token, ...q }) });
  const j = await res.json();
  const rep = j.reports?.find((x: any) => x.source_id === source);
  return { ms: Date.now() - t, ok: j.ok && rep?.ok, hits: (j.hits ?? []).map((h: any) => h.record), verification: j.verification?.status };
}

let pass = 0, fail = 0;
for (const f of files) {
  const text = fs.readFileSync(`${dir}/${f}`, which === "ca" && !f.endsWith(".tsv") ? "latin1" : "utf8");
  const all = (which === "ca" ? parseCaDcaTsv(text) : parseMichiganTsv(text)).rows;
  const individuals = all.filter((r) => r.first_name && r.last_name);
  const rows = individuals.length >= 20 ? individuals : all; // boards that are almost all businesses (cemeteries, funeral, ...) are sampled by business name
  console.log(`\n== ${f}  (${individuals.length} individuals / ${all.length} records in file)`);
  for (let k = 1; k <= perFile; k++) {
    const r = rows[Math.floor((rows.length * k) / (perFile + 1))];
    const want = r.record;
    const same = (h: any) => h.license_number === want.license_number && h.license_holder_name === want.license_holder_name && h.license_type === want.license_type && h.board_agency === want.board_agency;
    const who = r.first_name && r.last_name ? { first_name: r.first_name, last_name: r.last_name } : { business_name: want.license_holder_name };
    const byName = await ask(who);
    const byNum = await ask({ license_number: want.license_number });
    const a = byName.hits.find(same), b = byNum.hits.find(same);
    const okRow = byName.ok && byNum.ok && a && b;
    okRow ? pass++ : fail++;
    console.log(`  ${okRow ? "PASS" : "FAIL"}  "${want.license_holder_name}"  by name: ${byName.hits.length} hit(s) ${byName.ms}ms | by number ${want.license_number}: ${byNum.hits.length} hit(s) ${byNum.ms}ms`);
    if (a) console.log(`        -> ${a.license_type} | ${a.status} (${a.status_raw}) | issued ${a.issue_date} | expires ${a.expiration_date} | ${a.board_agency}`);
  }
}
console.log(`\n${pass} of ${pass + fail} samples found by BOTH name and number`);
process.exitCode = fail ? 1 : 0;
