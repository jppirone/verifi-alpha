// Verifies the bucket against the build: reads EVERY stored shard back out of storage (through the deployed registry-ingest shard_stats
// action, which holds the service key) and compares row counts and per (board, license type, status) fingerprint sums with the build manifest.
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=... node tools/registry/verify-shards.ts <shardsDir> <source_id>
// Name shards are checked group by group; number shards must add up to the same total rows (they hold the second copy of every record).
import fs from "node:fs";
import path from "node:path";

const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
const [dir, sourceId] = process.argv.slice(2);
if (!base || !anon || !token || !dir || !sourceId) { console.error("set REGISTRY_URL, SUPABASE_ANON_KEY, STAFF_TOKEN; args: <shardsDir> <source_id>"); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, sourceId, "manifest.json"), "utf8"));

async function stats(p: string): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${base}/functions/v1/registry-ingest`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ action: "shard_stats", path: p, staff_session_token: token }) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status >= 500 && attempt < 5) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error(`shard_stats ${p}: ${res.status} ${text.slice(0, 200)}`);
  }
}
const list = (sub: string) => fs.readdirSync(path.join(dir, sourceId, sub)).filter((f) => f.endsWith(".parquet")).map((f) => `${sourceId}/${sub}/${f}`);

async function run(paths: string[]) {
  const total = { n: 0, bytes: 0, groups: new Map<string, { n: number; chk: bigint }>() };
  const queue = [...paths]; let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const s = await stats(p);
      total.n += s.n; total.bytes += s.bytes;
      for (const [k, g] of Object.entries<any>(s.groups)) { const t = total.groups.get(k) ?? { n: 0, chk: 0n }; t.n += g.n; t.chk += BigInt(g.chk); total.groups.set(k, t); }
      if (++done % 250 === 0) console.log(`    ${done}/${paths.length}`);
    }
  }));
  return total;
}

console.log(`reading ${list("name").length} name shards + ${list("num").length} number shards back from the bucket ...`);
const name = await run(list("name"));
const num = await run(list("num"));
let bad = 0;
const want = new Map<string, { n: number; chk: string }>(manifest.fingerprint_groups.map((g: any) => [`${g.board_agency}|${g.license_type ?? ""}|${g.status}`, g]));
for (const [k, g] of want) { const got = name.groups.get(k); if (!got || got.n !== g.n || got.chk.toString() !== g.chk) { bad++; if (bad <= 5) console.log("MISMATCH", k, "built", g.n, g.chk, "stored", got?.n, got?.chk.toString()); } }
for (const k of name.groups.keys()) if (!want.has(k)) { bad++; console.log("EXTRA GROUP in bucket", k); }
console.log(`name shards:   ${name.n} rows in bucket vs ${manifest.rows} built; ${want.size} (board, type, status) groups compared; mismatches: ${bad}`);
console.log(`number shards: ${num.n} rows in bucket vs ${manifest.rows} built (second copy of every record)`);
console.log(`stored bytes read back: ${(name.bytes + num.bytes).toLocaleString()} vs ${manifest.parquet_bytes.total.toLocaleString()} built`);
const ok = bad === 0 && name.n === manifest.rows && num.n === manifest.rows && name.bytes + num.bytes === manifest.parquet_bytes.total;
console.log(ok ? "VERIFIED: the bucket holds exactly what was built" : "VERIFICATION FAILED");
process.exitCode = ok ? 0 : 1;
