// Evidence for "is this business registry active-only or full history?": the dataset's own description and columns, any status-like column,
// and companion datasets on the same portal. Everything printed is read from the live portals.
//   node tools/registry/completeness-eval.mjs
const SOURCES = [
  { id: "NY", domain: "data.ny.gov", ds: "n9v6-gdp6" },
  { id: "OR", domain: "data.oregon.gov", ds: "tckn-sxa6" },
  { id: "PA", domain: "data.pa.gov", ds: "xvd7-5r2c" },
  { id: "CO (reference, full history)", domain: "data.colorado.gov", ds: "4ykn-tg5h" },
];
const j = async (u) => { const r = await fetch(u); return r.ok ? r.json() : { error: r.status }; };
const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
for (const s of SOURCES) {
  console.log(`\n=================== ${s.id}  ${s.domain}/${s.ds}`);
  const m = await j(`https://${s.domain}/api/views/${s.ds}.json`);
  console.log(`name: "${m.name}"`);
  console.log(`description: ${strip(m.description).slice(0, 900)}`);
  console.log(`attribution: ${m.attribution ?? "-"} | category: ${m.category ?? "-"} | rows updated ${m.rowsUpdatedAt ? new Date(m.rowsUpdatedAt * 1000).toISOString() : "-"}`);
  const cols = (m.columns ?? []).map((c) => c.fieldName).filter((c) => !c.startsWith(":"));
  console.log(`columns (${cols.length}): ${cols.join(", ")}`);
  console.log(`status-like columns: ${cols.filter((c) => /status|state_of|dissol|inactive|active|end_date|termin|cancel|expire/i.test(c)).join(", ") || "NONE"}`);
  const cnt = await j(`https://${s.domain}/resource/${s.ds}.json?$select=count(*)`);
  console.log(`rows: ${Number(cnt[0]?.count).toLocaleString()}`);
}

console.log("\n\n=================== companion datasets on each portal (catalog search)");
for (const [d, q] of [["data.ny.gov", "corporation"], ["data.ny.gov", "dissolved"], ["data.oregon.gov", "business"], ["data.oregon.gov", "inactive"], ["data.pa.gov", "business"], ["data.pa.gov", "dissol"]]) {
  const r = await j(`https://api.us.socrata.com/api/catalog/v1?domains=${d}&q=${encodeURIComponent(q)}&only=dataset&limit=12`);
  console.log(`\n${d}  q="${q}":`);
  for (const x of r.results ?? []) console.log(`   ${x.resource.id}  "${x.resource.name}"  (${x.classification?.domain_category ?? "-"}; ${x.resource.attribution ?? "-"})`);
}
