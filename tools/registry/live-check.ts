// End-to-end check against the DEPLOYED registry-lookup function: one real query per source, printing the raw normalized output.
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=... node tools/registry/live-check.ts
const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
if (!base || !anon || !token) { console.error("set REGISTRY_URL, SUPABASE_ANON_KEY, STAFF_TOKEN"); process.exit(2); }

async function lookup(body: Record<string, unknown>) {
  const t = Date.now();
  const res = await fetch(`${base}/functions/v1/registry-lookup`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ ...body, staff_session_token: token }) });
  return { status: res.status, ms: Date.now() - t, json: await res.json().catch(() => null) };
}
function show(title: string, r: { status: number; ms: number; json: any }, perSource = 1) {
  console.log(`\n##### ${title}  -> HTTP ${r.status}, ${r.ms} ms`);
  if (!r.json?.ok) { console.log(JSON.stringify(r.json)); return; }
  for (const rep of r.json.reports) console.log(`  [${rep.ok ? "ok " : "ERR"}] ${rep.source_id.padEnd(10)} ${rep.kind.padEnd(8)} count=${rep.count} ${rep.ms}ms${rep.raw_rows !== undefined ? ` raw_rows=${rep.raw_rows} entities=${rep.entities}` : ""}${rep.skipped ? ` SKIPPED: ${rep.skipped}` : rep.error ? ` error=${rep.error} ${rep.detail ?? ""}` : ""}`);
  if (r.json.not_loaded?.length) console.log(`  not loaded (no completed ingest): ${r.json.not_loaded.map((n: any) => n.source_id).join(", ")}`);
  const seen: Record<string, number> = {};
  for (const h of r.json.hits) { seen[h.source_id] = (seen[h.source_id] ?? 0) + 1; if (seen[h.source_id] <= perSource) console.log(`  ${h.source_id} (${h.match_type}${h.name_match === undefined ? "" : ", name_match=" + h.name_match}): ${JSON.stringify(h.record)}`); }
}

const cases: Array<[string, Record<string, unknown>]> = [
  ["BUSINESS name=Google (CO, NY, CT, OR, PA + any loaded DB source)", { kind: "business", name: "Google", limit: 3 }],
  ["BUSINESS by entity id (CO)", { kind: "business", entity_id: "20198003754", states: ["CO"] }],
  ["BUSINESS CT with principals/agents", { kind: "business", name: "Yale Alley Cats", states: ["CT"], include_people: true, limit: 1 }],
  ["LICENSE name=Samantha Wilson", { kind: "license", name: "Samantha Wilson", limit: 3 }],
  ["LICENSE CA individual by first+last", { kind: "license", first_name: "Maryam", last_name: "Rahnema", states: ["CA"], limit: 3 }],
  ["LICENSE CA by number (Psychologist 10000)", { kind: "license", license_number: "10000", states: ["CA"], limit: 3 }],
  ["LICENSE business name (IL / WA)", { kind: "license", business_name: "NATIONAL UNIVERSITY OF HEALTH SCIENCES", limit: 2 }],
  ["LICENSE Delaware (live Socrata, public roster)", { kind: "license", first_name: "Mark", last_name: "Schlangel", states: ["DE"], limit: 3 }],
  ["LICENSE Delaware by number", { kind: "license", license_number: "M9-0012482", states: ["DE"], limit: 3 }],
  ["LICENSE Michigan (ingested Real Estate group)", { kind: "license", business_name: "East Central LLC", states: ["MI"], limit: 3 }],
  ["LICENSE nonsense name -> honest empty, not an error", { kind: "license", name: "Zzqxv Plmnbv", limit: 3 }],
];
for (const [title, body] of cases) show(title, await lookup(body));
