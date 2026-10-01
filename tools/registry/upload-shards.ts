// Uploads a built shard directory (tools/registry/build-shards.ts output) to the private `registry-data` bucket through the deployed
// registry-ingest function (the only holder of the storage service key), as one recorded ingest run, then prunes stale objects.
//   REGISTRY_URL=... SUPABASE_ANON_KEY=... STAFF_TOKEN=<admin staff session> node tools/registry/upload-shards.ts <shardsDir> <source_id>
import fs from "node:fs";
import path from "node:path";

const base = process.env.REGISTRY_URL, anon = process.env.SUPABASE_ANON_KEY, token = process.env.STAFF_TOKEN;
const [dir, sourceId] = process.argv.slice(2);
if (!base || !anon || !token || !dir || !sourceId) { console.error("set REGISTRY_URL, SUPABASE_ANON_KEY, STAFF_TOKEN; args: <shardsDir> <source_id>"); process.exit(2); }

async function call(body: Record<string, unknown>): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${base}/functions/v1/registry-ingest`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ ...body, staff_session_token: token }) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status >= 500 && attempt < 5) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error(`registry-ingest ${res.status}: ${text.slice(0, 300)}`);
  }
}

const root = path.join(dir, sourceId);
const files: string[] = [];
(function walk(d: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(root);
const rel = (p: string) => path.relative(dir, p).split(path.sep).join("/");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const { run_id } = await call({ action: "begin", source_id: sourceId, kind: "license", file_name: manifest.inputs.map((i: any) => i.file).join(", ").slice(0, 280), note: `storage upload, ${manifest.rows} rows, ${files.length} objects` });
console.log(`run ${run_id}: uploading ${files.length} objects (${(files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1e6).toFixed(1)} MB)`);
let done = 0, bytes = 0;
const queue = [...files];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const buf = fs.readFileSync(f);
    await call({ action: "put_shard", run_id, path: rel(f), content_b64: buf.toString("base64") });
    done++; bytes += buf.length;
    if (done % 200 === 0) console.log(`  ${done}/${files.length}`);
  }
}));
const fin = await call({ action: "finish", run_id, prune_storage: true, shard_paths: files.map(rel), rows_total: manifest.rows });
console.log(`uploaded ${done} objects, ${(bytes / 1e6).toFixed(2)} MB ->`, JSON.stringify(fin));
