// Evaluation of Socrata business registries as the first Knowledge Base source: size, status vocabulary, freshness, live latency, and what a
// bulk copy would cost. Everything printed is measured against the live datasets.
//   node tools/registry/registry-eval.mjs
const SOURCES = [
  { id: "CO", domain: "data.colorado.gov", ds: "4ykn-tg5h", name: "entityname", status: "entitystatus", id_f: "entityid", type: "entitytype", date: "entityformdate" },
  { id: "CT", domain: "data.ct.gov", ds: "n7gp-d28j", name: "name", status: "status", id_f: "accountnumber", type: "business_type", date: "date_registration" },
  { id: "NY", domain: "data.ny.gov", ds: "n9v6-gdp6", name: "current_entity_name", status: null, id_f: "dos_id", type: "entity_type", date: "initial_dos_filing_date" },
];
const get = async (url) => { const t = performance.now(); const r = await fetch(url, { headers: { Accept: "application/json" } }); const ms = performance.now() - t; return { ok: r.ok, status: r.status, ms, json: r.ok ? await r.json() : null, text: r.ok ? "" : await r.text() }; };
const q = (s, p) => `https://${s.domain}/resource/${s.ds}.json?${p}`;
for (const s of SOURCES) {
  console.log(`\n=== ${s.id}  ${s.domain}/${s.ds}`);
  const meta = await get(`https://${s.domain}/api/views/${s.ds}.json`);
  if (meta.ok) console.log(`  dataset: "${meta.json.name}" | rows updated ${new Date(meta.json.rowsUpdatedAt * 1000).toISOString()} | last modified ${new Date(meta.json.viewLastModified * 1000).toISOString()} | columns ${meta.json.columns?.length}`);
  const cnt = await get(q(s, "$select=count(*)"));
  const total = cnt.ok ? Number(cnt.json[0].count) : null;
  console.log(`  total rows: ${total?.toLocaleString()}`);
  if (s.status) {
    const st = await get(q(s, `$select=${s.status},count(*)%20as%20n&$group=${s.status}&$order=n%20desc&$limit=30`));
    if (st.ok) console.log("  status values:", st.json.map((x) => `${x[s.status]}=${Number(x.n).toLocaleString()}`).join(" | "));
    else console.log("  status query failed", st.status, st.text.slice(0, 120));
  } else console.log("  (no status column: active entities only)");
  const sample = await get(q(s, "$limit=1000"));
  if (sample.ok) {
    const bytes = JSON.stringify(sample.json).length / sample.json.length;
    console.log(`  average row ~${Math.round(bytes)} bytes as JSON; a full bulk copy ~ ${(bytes * total / 1e6).toFixed(0)} MB JSON (CSV is smaller)`);
  }
  // live latency: exact-name lookups for names that exist (taken from the dataset) and ones that do not
  const names = sample.ok ? sample.json.slice(100, 120).map((r) => r[s.name]).filter(Boolean) : [];
  const lat = [];
  for (const n of names) { const r = await get(q(s, `$where=upper(${s.name})=${encodeURIComponent("'" + n.toUpperCase().replace(/'/g, "''") + "'")}&$limit=5`)); if (r.ok) lat.push(r.ms); }
  const miss = []; for (let i = 0; i < 5; i++) { const r = await get(q(s, `$where=upper(${s.name})=${encodeURIComponent("'ZZQXV NONEXISTENT " + i + " LLC'")}&$limit=5`)); if (r.ok) miss.push(r.ms); }
  const stat = (a) => (a.length ? `median ${Math.round(a.sort((x, y) => x - y)[Math.floor(a.length / 2)])} ms, max ${Math.round(Math.max(...a))} ms (n=${a.length})` : "n/a");
  console.log(`  live exact-name lookup latency: existing names ${stat(lat)} | non-existent ${stat(miss)}`);
  // does the engine support regexp_replace for punctuation-insensitive matching server-side?
  const rr = await get(q(s, `$select=${s.name}&$where=regexp_replace(upper(${s.name}),'[^A-Z0-9 ]','')=${encodeURIComponent("'GOOGLE LLC'")}&$limit=2`));
  console.log(`  regexp_replace in $where: ${rr.ok ? `supported (${Math.round(rr.ms)} ms, ${rr.json.length} rows)` : `not usable (${rr.status} ${rr.text.slice(0, 100).replace(/\n/g, " ")})`}`);
}
