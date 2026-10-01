// NOTE (2026-10-01): superseded by build-shards.ts + upload-shards.ts (object storage). This database path remains only for small sources.
// Loads Michigan LARA license lists (TSV from xlsx-to-tsv.py) into license_records through the deployed registry-ingest function.
//   REGISTRY_URL=https://<ref>.supabase.co STAFF_TOKEN=<admin staff session token> \
//     node tools/registry/ingest-mi.ts <dir> <file> [file ...] [--prune]
// Each file is parsed with the SAME parser the tests use (supabase/functions/_shared/registry/michigan.ts), posted in batches of
// 500, and recorded as one ingest run (file name + sha256). The anon/publishable key is sent as `apikey` because the function
// gateway requires a key; identity comes from the staff session token in the body.
import fs from "node:fs";
import crypto from "node:crypto";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";

const base = process.env.REGISTRY_URL, token = process.env.STAFF_TOKEN, anon = process.env.SUPABASE_ANON_KEY;
if (!base || !token || !anon) { console.error("set REGISTRY_URL, STAFF_TOKEN and SUPABASE_ANON_KEY"); process.exit(2); }
const args = process.argv.slice(2);
const prune = args.includes("--prune");
const [dir, ...files] = args.filter((a) => a !== "--prune");

async function call(body: Record<string, unknown>): Promise<any> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${base}/functions/v1/registry-ingest`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: anon!, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ ...body, staff_session_token: token }),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error(`registry-ingest ${res.status}: ${text.slice(0, 300)}`);
  }
}

for (const f of files) {
  const buf = fs.readFileSync(`${dir}/${f}`);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const { rows, stats } = parseMichiganTsv(buf.toString("utf8"));
  const { run_id } = await call({ action: "begin", source_id: "mi-lara", kind: "license", file_name: f, file_sha256: sha, note: `parsed ${stats.parsed}, parser-rejected ${stats.rejected}` });
  let up = 0, rej = 0, dupes = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await call({ action: "batch", run_id, rows: rows.slice(i, i + 500).map((x) => ({ record_key: x.record_key, last_name: x.last_name, first_name: x.first_name, record: x.record })) });
    up += r.upserted; rej += r.rejected; dupes += r.duplicates_in_batch;
    if (r.rejected) console.log("  rejected sample:", r.rejected_samples);
  }
  const fin = await call({ action: "finish", run_id, prune });
  console.log(`${f}: parsed=${stats.parsed} parser_rejected=${stats.rejected} upserted=${up} server_rejected=${rej} in_batch_dupes=${dupes} ->`, JSON.stringify(fin));
}
