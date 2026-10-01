// Oregon: the monthly "New Business List - <Month>" datasets list every registration of that month. Entities from them that are NOT in
// "Active Businesses - ALL" have, by definition, left the active register since: if any exist, the active dataset excludes inactive businesses.
const j = async (u) => { for (let i = 0; i < 3; i++) { const r = await fetch(u); if (r.ok) return r.json(); await new Promise((x) => setTimeout(x, 800)); } throw new Error("fetch failed " + u.slice(0, 120)); };
const q = encodeURIComponent;
const cat = await j("https://api.us.socrata.com/api/catalog/v1?domains=data.oregon.gov&q=" + q("New Business List") + "&only=dataset&limit=30");
const lists = (cat.results ?? []).filter((r) => /^New Business List - /.test(r.resource.name)).map((r) => ({ id: r.resource.id, name: r.resource.name }));
console.log(`${lists.length} monthly lists found`);
let tested = 0, missing = 0;
const rows = [];
for (const l of lists) {
  const range = (await j(`https://data.oregon.gov/resource/${l.id}.json?$select=min(registry_date),max(registry_date)`))[0];
  const ids = (await j(`https://data.oregon.gov/resource/${l.id}.json?$select=registry_number&$group=registry_number&$order=registry_number&$limit=1500`)).map((x) => x.registry_number);
  const sample = ids.filter((_, i) => i % Math.max(1, Math.floor(ids.length / 600)) === 0).slice(0, 600);
  let present = 0;
  for (let i = 0; i < sample.length; i += 150) {
    const chunk = sample.slice(i, i + 150);
    const r = await j(`https://data.oregon.gov/resource/tckn-sxa6.json?$select=registry_number&$group=registry_number&$where=${q(`registry_number in (${chunk.map((x) => `'${x}'`).join(",")})`)}&$limit=500`);
    present += r.length;
  }
  tested += sample.length; missing += sample.length - present;
  rows.push({ list: l.name, from: String(range.min_registry_date).slice(0, 10), to: String(range.max_registry_date).slice(0, 10), sampled: sample.length, in_active: present, not_in_active: sample.length - present, pct_gone: +(100 * (sample.length - present) / sample.length).toFixed(1) });
}
rows.sort((a, b) => a.from.localeCompare(b.from));
for (const r of rows) console.log(`  ${r.list.padEnd(30)} registered ${r.from}..${r.to}  sampled ${String(r.sampled).padStart(3)} entities: still in the active list ${String(r.in_active).padStart(3)}, NOT in it ${String(r.not_in_active).padStart(3)} (${r.pct_gone}%)`);
console.log(`TOTAL sampled ${tested} registered entities: ${missing} (${(100 * missing / tested).toFixed(1)}%) are no longer in "Active Businesses - ALL" -> the dataset excludes businesses that left the active register`);
