// Live test of the Knowledge Base against the DEPLOYED kb-verify-business function, Colorado SOS registry, real employers.
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=... node tools/registry/kb-live-test.mjs a     (misses, hits, the 25-candidate case, rejects)
//   ... (back-date one entity in SQL: update kb_entities set last_verified_at = now() - interval '100 days' where name = 'Newmont Corporation')
//   REGISTRY_URL=... node tools/registry/kb-live-test.mjs b                                            (stale refresh, force_refresh, stats)
const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
const phase = process.argv[2] || "a";
async function kb(body) {
  const t = Date.now();
  const res = await fetch(`${base}/functions/v1/kb-verify-business`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ ...body, staff_session_token: token }) });
  const j = await res.json(); j.wall = Date.now() - t; j.http = res.status; return j;
}
const line = (label, r) => console.log(`  ${label.padEnd(46)} ${String(r.status).padEnd(20)} cache=${String(r.cache_result).padEnd(6)} registry_called=${String(r.registry?.queried).padEnd(5)} calls=${r.registry?.calls} ${String(r.wall).padStart(4)}ms${r.entity ? `  -> ${r.entity.name} [${r.entity.registry_entity_id}] ${r.entity.status_raw}, verified x${r.entity.verification_count}, stale after ${r.entity.stale_after_days}d` : ""}`);

if (phase === "a") {
  console.log("== 0. stats before");
  console.log(JSON.stringify((await kb({ action: "stats" })).stats));

  console.log("\n== 1. first lookup of a real employer = cache MISS -> live registry -> written back; then the same employer again");
  for (const n of ["Ball Corporation", "Ball Corporation", "BALL CORPORATION", "ball corporation.", "Ball Corporation "]) line(JSON.stringify(n), await kb({ name: n, state: "CO" }));

  console.log("\n== 2. punctuation the registry files differently (registered as 'DaVita Inc.')");
  for (const n of ["DaVita Inc", "DAVITA, INC.", "davita inc"]) line(JSON.stringify(n), await kb({ name: n, state: "CO" }));

  console.log("\n== 3. the motivating case: one employer listed by 25 different candidates (25 locations, assorted spellings)");
  const spellings = ["Molson Coors Beverage Company", "MOLSON COORS BEVERAGE COMPANY", "Molson Coors Beverage Company.", "molson coors beverage company", "Molson  Coors Beverage Company", "Molson Coors Beverage Company,"];
  let hits = 0, regCalls = 0;
  for (let i = 0; i < 25; i++) {
    const r = await kb({ name: spellings[i % spellings.length], state: "CO" });
    if (r.cache_result === "hit") hits++;
    regCalls += r.registry?.calls ?? 0;
    if (i < 3 || i === 24) line(`candidate #${i + 1}: ${JSON.stringify(spellings[i % spellings.length])}`, r);
  }
  console.log(`  -> 25 candidates: ${hits} cache hits, ${25 - hits} registry verification, ${regCalls} registry call(s) in total (one lookup per candidate would have been 25+)`);

  console.log("\n== 4. what the cache will NOT guess (these are the misses the log exists to study)");
  for (const [n, st] of [["Ball Corp", "CO"], ["Arrow Electronics", "CO"], ["DaVita Incorporated", "CO"], ["Western Union Financial Services, Inc.", "CO"], ["Zzqxv Nonexistent Holdings LLC", "CO"], ["Ball Corporation", "TX"]]) {
    const r = await kb({ name: n, state: st }); line(`${n} (${st})`, r);
    if (r.manual_verification_required) console.log(`        manual verification: ${r.message.slice(0, 200)}`);
    if (r.candidates) console.log(`        candidates: ${r.candidates.map((c) => `${c.registry_entity_id} ${c.status_raw}`).join(" | ")}`);
  }

  console.log("\n== 4b. an entity to back-date for the staleness test");
  for (const n of ["Newmont Corporation", "Newmont Corporation"]) line(JSON.stringify(n), await kb({ name: n, state: "CO" }));
}

if (phase === "b") {
  console.log("== 5. staleness: Newmont was back-dated to 100 days ago (policy for an active entity: re-verify after 90 days)");
  line("Newmont Corporation (stale)", await kb({ name: "Newmont Corporation", state: "CO" }));
  line("Newmont Corporation (fresh again)", await kb({ name: "Newmont Corporation", state: "CO" }));
  line("Newmont Corporation (force_refresh)", await kb({ name: "Newmont Corporation", state: "CO", force_refresh: true }));
  console.log("\n== 6. stats from kb_lookup_log");
  console.log(JSON.stringify((await kb({ action: "stats" })).stats, null, 1));
}

if (phase === "c") {
  console.log("== C1. Connecticut (second registry): real employers, first lookup = miss -> live CT registry -> written back; repeat = hit");
  for (const n of ["Aetna Inc.", "AETNA INC", "The Travelers Companies, Inc.", "Stanley Black & Decker, Inc.", "STANLEY BLACK AND DECKER INC", "Xerox Corporation", "Hartford Fire Insurance Company", "Yale University", "Frontier Communications Corporation"]) line(JSON.stringify(n), await kb({ name: n, state: "CT" }));

  console.log("\n== C2. one employer listed by 25 candidates in Connecticut");
  const sp = ["Stanley Black & Decker, Inc.", "STANLEY BLACK & DECKER INC.", "Stanley Black and Decker, Inc", "stanley black & decker inc"];
  let hits = 0, calls = 0;
  for (let i = 0; i < 25; i++) { const r = await kb({ name: sp[i % sp.length], state: "CT" }); if (r.cache_result === "hit") hits++; calls += r.registry?.calls ?? 0; }
  console.log(`  -> 25 lookups: ${hits} cache hits, ${calls} registry call(s) in total`);

  console.log("\n== C3. state scoping: the cache is keyed on state + name, so the same name in another state is its own lookup");
  line("Xerox Corporation (CT)", await kb({ name: "Xerox Corporation", state: "CT" }));
  line("Xerox Corporation (CO)", await kb({ name: "Xerox Corporation", state: "CO" }));
  line("Xerox Corporation (TX, no source)", await kb({ name: "Xerox Corporation", state: "TX" }));

  console.log("\n== C4. THE NEW RULE: several registered entities share the exact name, exactly ONE is active -> resolves automatically");
  const w = await kb({ name: "Western Union Financial Services, Inc.", state: "CO" });
  line("Western Union Financial Services, Inc. (CO)", w);
  console.log(`     resolution: ${JSON.stringify(w.resolution)}`);
  console.log(`     message: ${w.message}`);
  line("WESTERN UNION FINANCIAL SERVICES INC (CO) again", await kb({ name: "WESTERN UNION FINANCIAL SERVICES INC", state: "CO" }));

  console.log("\n== C5. what still needs a human");
  for (const [n, st] of [["Cigna Corporation", "CT"], ["Webster Bank", "CT"], ["Zzqxv Nonexistent Holdings LLC", "CT"]]) { const r = await kb({ name: n, state: st }); line(`${n} (${st})`, r); if (r.manual_verification_required) console.log(`        ${r.message.slice(0, 190)}`); }

  console.log("\n== C6. stats");
  console.log(JSON.stringify((await kb({ action: "stats" })).stats));
}

if (phase === "d") {
  console.log("== D1. New York (active_only): real employers; first lookup = miss -> live registry -> written back tagged active_only; repeat = hit");
  for (const n of ["International Business Machines Corporation", "INTERNATIONAL BUSINESS MACHINES CORP", "Pfizer Inc.", "pfizer inc", "The Goldman Sachs Group, Inc.", "Corning Incorporated", "Lehman Brothers Inc."]) { const r = await kb({ name: n, state: "NY" }); line(JSON.stringify(n), r); }
  console.log("\n== D2. Oregon (active_only)");
  for (const n of ["Nike, Inc.", "NIKE INC", "Columbia Sportswear Company", "Intel Corporation", "Precision Castparts Corp."]) line(JSON.stringify(n), await kb({ name: n, state: "OR" }));
  console.log("\n== D3. what a MISS means in an active-only registry (the wording differs from Colorado / Connecticut)");
  for (const [n, st] of [["Zzqxv Nonexistent Holdings LLC", "NY"], ["Zzqxv Nonexistent Holdings LLC", "CO"]]) { const r = await kb({ name: n, state: st }); line(`${n} (${st})`, r); console.log(`        completeness=${r.registry.completeness}\n        ${r.message}`); }
  console.log("\n== D4. Pennsylvania is NOT enabled");
  const pa = await kb({ name: "Sears Holdings Llc", state: "PA" }); line("Sears Holdings Llc (PA)", pa); console.log(`        ${pa.message}`);
  console.log("\n== D5. completeness on Colorado / Connecticut stays full_history");
  for (const [n, st] of [["Ball Corporation", "CO"], ["Aetna Inc.", "CT"]]) { const r = await kb({ name: n, state: st }); line(`${n} (${st})`, r); console.log(`        completeness=${r.registry.completeness}  entity.source_completeness=${r.entity.source_completeness}`); }
}
if (phase === "e") {
  console.log("== E. an entity the KB verified as active earlier (100 days ago) that is no longer on New York's active list");
  const r = await kb({ name: "Zzqx Former Holdings Corp", state: "NY" });
  line("Zzqx Former Holdings Corp (NY)", r);
  console.log(`        disappeared_from_active_register=${r.disappeared_from_active_register}  completeness=${r.registry.completeness}\n        ${r.message}`);
  console.log("\n== stats"); console.log(JSON.stringify((await kb({ action: "stats" })).stats));
}
