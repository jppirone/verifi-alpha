// Live check of the manual-verification block (Part 3) against the DEPLOYED registry-lookup. Needs REGISTRY_URL, SUPABASE_ANON_KEY, STAFF_TOKEN.
const ask = async (body) => { const t = Date.now(); const r = await (await fetch(process.env.REGISTRY_URL + "/functions/v1/registry-lookup", { method: "POST", headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY, Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY }, body: JSON.stringify({ staff_session_token: process.env.STAFF_TOKEN, ...body }) })).json(); return { ...r, wall: Date.now() - t }; };
const cases = [
  ["A. Florida business (no automated source loaded)", { kind: "business", name: "Publix Super Markets", states: ["FL"] }],
  ["B. Florida license (no automated source loaded)", { kind: "license", first_name: "Jane", last_name: "Doe", states: ["FL"] }],
  ["C. Texas (state we have no source for at all)", { kind: "license", name: "Jane Doe", states: ["TX"] }],
  ["D. CA license that does not exist (searched OK, nothing matched)", { kind: "license", first_name: "Zzqxv", last_name: "Plmnbvq", states: ["CA"] }],
  ["E. Found in CA but Florida also requested", { kind: "license", first_name: "Maryam", last_name: "Rahnema", states: ["CA", "FL"] }],
  ["F. Plain found, no gaps (CA, from storage)", { kind: "license", first_name: "Maryam", last_name: "Rahnema", states: ["CA"] }],
  ["G. No state given, nothing found anywhere", { kind: "license", name: "Zzqxv Plmnbvq" }],
];
for (const [t, b] of cases) {
  const r = await ask(b); const v = r.verification;
  console.log(`\n### ${t}  (HTTP ok=${r.ok}, ${r.wall} ms, hits=${r.hits?.length})`);
  console.log(`  status: ${v.status} | manual_verification_required: ${v.manual_verification_required}`);
  console.log(`  searched: [${v.searched_sources.join(", ")}] failed: ${JSON.stringify(v.failed_sources)} not_loaded: [${v.not_loaded_sources.join(", ")}] uncovered states: [${v.states_without_automated_coverage.join(", ")}]`);
  console.log(`  message: ${v.message}`);
  const st = r.reports.find((x) => x.kind === "storage"); if (st) console.log(`  storage source ${st.source_id}: ${st.ms} ms, shard reads=${st.attempts}`);
}
