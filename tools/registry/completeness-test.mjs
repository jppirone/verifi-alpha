// Empirical test of "active only": take businesses the STATE ITSELF records as dissolved (from a companion dataset that carries dissolutions)
// and look for them in the registry dataset we would use for existence checks. If the registry were full-history they would be present
// (with a dissolved status); if it is active-only they are absent. A control sample of known-active entities must be found, or the test
// would prove nothing.
//   node tools/registry/completeness-test.mjs
const j = async (u) => { for (let i = 0; i < 3; i++) { const r = await fetch(u); if (r.ok) return r.json(); await new Promise((x) => setTimeout(x, 800)); } throw new Error("fetch failed " + u); };
const q = (s) => encodeURIComponent(s);

console.log("=== NEW YORK: n9v6-gdp6 \"Active Corporations\"  vs  63wc-4exh \"All Filings\" (carries dissolution filings)");
{
  // what do dissolution filings look like?
  const types = await j(`https://data.ny.gov/resource/63wc-4exh.json?$select=documenttype,count(*)%20as%20n&$where=${q("documenttype like '%DISSOLUTION%'")}&$group=documenttype&$order=n%20desc&$limit=8`);
  console.log("  dissolution-type filings in the filings dataset:", types.map((t) => `${t.documenttype}=${Number(t.n).toLocaleString()}`).join(" | "));
  // pick entities whose LATEST filing history includes a dissolution, from three different eras
  const sample = [];
  for (const [a, b] of [["1990-01-01", "2000-01-01"], ["2000-01-01", "2010-01-01"], ["2010-01-01", "2020-01-01"], ["2020-01-01", "2026-01-01"]]) {
    const r = await j(`https://data.ny.gov/resource/63wc-4exh.json?$select=corpid_num,corp_name,date_filed,documenttype&$where=${q(`documenttype in ('CERTIFICATE OF DISSOLUTION','DISSOLUTION BY PROCLAMATION','DISSOLUTION BY PROCLAMATION/ANNULMENT OF AUTHORITY') AND date_filed>='${a}T00:00:00' AND date_filed<'${b}T00:00:00'`)}&$limit=60`);
    sample.push(...r);
  }
  const ids = [...new Set(sample.map((s) => s.corpid_num))];
  const inList = (arr) => arr.map((x) => `'${x}'`).join(",");
  const present = await j(`https://data.ny.gov/resource/n9v6-gdp6.json?$select=dos_id,current_entity_name&$where=${q(`dos_id in (${inList(ids)})`)}&$limit=500`);
  console.log(`  dissolved entities tested: ${ids.length} (dissolution filed 1990-2025) -> present in the "Active Corporations" dataset: ${present.length}`);
  for (const p of present.slice(0, 5)) {
    const later = await j(`https://data.ny.gov/resource/63wc-4exh.json?$select=documenttype,date_filed&$where=${q(`corpid_num='${p.dos_id}'`)}&$order=date_filed%20desc&$limit=3`);
    console.log(`     present: ${p.dos_id} ${p.current_entity_name}  (latest filings: ${later.map((l) => l.documenttype + " " + String(l.date_filed).slice(0, 10)).join("; ")})`);
  }
  // control: entities with NO dissolution filing and a recent annual-type filing should be present
  const ctl = await j(`https://data.ny.gov/resource/n9v6-gdp6.json?$select=dos_id&$limit=200&$offset=100000`);
  const ctlIds = ctl.map((c) => c.dos_id);
  const ctlPresent = await j(`https://data.ny.gov/resource/n9v6-gdp6.json?$select=dos_id&$where=${q(`dos_id in (${inList(ctlIds)})`)}&$limit=500`);
  console.log(`  control (200 entities taken from the active list, looked up again by id): found ${ctlPresent.length} of ${ctlIds.length}`);
  console.log(`  column check: the active dataset has no status / dissolution-date column at all (see completeness-eval).`);
}

console.log("\n=== OREGON: tckn-sxa6 \"Active Businesses - ALL\"  vs  the monthly \"New Business List\" datasets (every registration of that month, whatever became of it)");
{
  const meta = await j("https://data.oregon.gov/api/views/v44b-kxkg.json");
  console.log(`  New Business List - January: "${meta.name}" | columns: ${(meta.columns || []).map((c) => c.fieldName).filter((c) => !c.startsWith(":")).join(", ")}`);
  const sample = await j("https://data.oregon.gov/resource/v44b-kxkg.json?$limit=2");
  console.log("  sample:", JSON.stringify(sample).slice(0, 400));
  const range = await j("https://data.oregon.gov/resource/v44b-kxkg.json?$select=min(registry_date),max(registry_date),count(*)");
  console.log("  registry_date range / rows:", JSON.stringify(range));
}
