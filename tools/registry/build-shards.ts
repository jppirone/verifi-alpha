// Builds the sharded Parquet files for a file-based source from its ORIGINAL downloaded files (same parsers the live checks use).
//   node tools/registry/build-shards.ts <source: ca-dca|mi-lara> <outDir> <inputDir> <file> [file ...]
// Output: <outDir>/<source>/name/xx.parquet, <outDir>/<source>/num/hh.parquet, <outDir>/<source>/manifest.json (with per-board /
// license-type / status fingerprints and the per-input parse statistics).
//
// STREAMING: the whole of California is ~3.9M rows, more than fits comfortably in memory. Each input is parsed in chunks, every record is
// spilled to a disk partition (one per shard), and each shard is then built from its own partition. A record's duplicates always land in
// the same partition (the key depends on the same fields that pick the shard), so de-duplication happens per partition.
//
// Codec is ZSTD level 19 (measured on real data: snappy 21.7 MB, gzip 14.1 MB, zstd 13.4 MB for the same 120k rows).
// Every record is checked against the common schema and the personal-data gate before it is written: no e-mail address anywhere, and no
// street address in a city / county field (the parsers blank those and count them in placeBlanked).
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";
import type { IngestLicense, ParseStats } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";
import { nameKey, containsEmail, looksLikeStreetAddress } from "../../supabase/functions/_shared/registry/normalize.ts";
import { PARQUET_COLUMNS, nameShardKeyFor, nameShardStem, numberShardStem, namePath, numberPath, manifestPath, rowFingerprint, setSha256 } from "../../supabase/functions/_shared/registry/shard.ts";
import type { ShardRow } from "../../supabase/functions/_shared/registry/shard.ts";

setSha256((x) => crypto.createHash("sha256").update(x).digest("hex"));
const [sourceId, outDir, inDir, ...files] = process.argv.slice(2);
if (!sourceId || !outDir || !inDir || files.length === 0) { console.error("usage: build-shards.ts <ca-dca|mi-lara> <outDir> <inputDir> <file...>"); process.exit(2); }

const parseText = (text: string): { rows: IngestLicense[]; stats: ParseStats } =>
  sourceId === "ca-dca" ? parseCaDcaTsv(text) : sourceId === "mi-lara" ? parseMichiganTsv(text) : (() => { throw new Error("unknown source " + sourceId); })();
const encodingFor = (f: string): BufferEncoding => (sourceId === "mi-lara" || f.endsWith(".tsv") ? "utf8" : "latin1");

type SpillRow = ShardRow & { _name: string; _rk: string };
const spillDir = path.join(outDir, "_spill");
fs.rmSync(spillDir, { recursive: true, force: true });
fs.mkdirSync(path.join(spillDir, "name"), { recursive: true });
fs.mkdirSync(path.join(spillDir, "num"), { recursive: true });
const buf = new Map<string, string[]>();
let bufChars = 0;
const flush = () => {
  for (const [k, v] of buf) fs.appendFileSync(path.join(spillDir, k + ".jsonl"), v.join("\n") + "\n");
  buf.clear(); bufChars = 0;
};
const spill = (key: string, r: SpillRow) => {
  const line = JSON.stringify(r);
  (buf.get(key) ?? buf.set(key, []).get(key)!).push(line);
  bufChars += line.length;
  if (bufChars > 150_000_000) flush();
};

// ---------------------------------------------------------------- pass 1: parse every input in chunks, spill by shard
const inputs: Array<Record<string, unknown>> = [];
const pre = new Map<string, number>(); // `${board}|${license_type}` -> rows parsed before de-duplication
let piiHits = 0, invalid = 0, parsedTotal = 0, placeBlankedTotal = 0;
const CHUNK = 40_000;
for (const f of files) {
  const raw = fs.readFileSync(path.join(inDir, f));
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const lines = raw.toString(encodingFor(f)).split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = lines[0] ?? "";
  const st = { file: f, sha256, bytes: raw.length, lines: lines.length - 1, parsed: 0, rejected: 0, rejectedSamples: [] as Array<{ line: number; reason: string }>, placeBlanked: 0 };
  for (let at = 1; at < lines.length; at += CHUNK) {
    const { rows, stats } = parseText([header, ...lines.slice(at, at + CHUNK)].join("\n"));
    st.parsed += stats.parsed; st.rejected += stats.rejected; st.placeBlanked += stats.placeBlanked ?? 0;
    for (const s of stats.rejectedSamples) if (st.rejectedSamples.length < 5) st.rejectedSamples.push({ line: s.line + at - 1, reason: s.reason });
    for (const p of rows) {
      const r = p.record;
      if (licenseProblems(r).length) { invalid++; continue; }
      const k = `${r.board_agency}|${r.license_type ?? ""}`;
      pre.set(k, (pre.get(k) ?? 0) + 1);
      // E-mail anywhere in a text field -> never stored. Street addresses are checked only where a PLACE belongs (city / county): business NAMES
      // such as "LENSCRAFTERS #083" or "130 South Ave LLC" legitimately look like addresses and must not be dropped.
      const texts = [r.license_holder_name, r.license_number, r.license_type, ...Object.values(r.details ?? {})];
      const place = [r.details?.city, r.details?.county];
      if (texts.some((t) => containsEmail(t)) || place.some((t) => typeof t === "string" && looksLikeStreetAddress(t))) { piiHits++; continue; }
      const row: SpillRow = {
        _name: nameKey(r.license_holder_name), _rk: p.record_key,
        last_key: p.last_name ? nameKey(p.last_name) : null, first_key: p.first_name ? nameKey(p.first_name) : null,
        license_holder_name: r.license_holder_name, holder_kind: r.holder_kind, license_number: r.license_number, license_type: r.license_type,
        status: r.status, status_raw: r.status_raw, issue_date: r.issue_date, expiration_date: r.expiration_date, state: r.state,
        board_agency: r.board_agency, source: r.source, details: JSON.stringify(r.details ?? {}),
      };
      spill("name/" + nameShardStem(nameShardKeyFor({ holder_kind: row.holder_kind!, last_key: row.last_key, name_key: row._name })), row);
      spill("num/" + numberShardStem(row.license_number!), row);
    }
  }
  parsedTotal += st.parsed; placeBlankedTotal += st.placeBlanked;
  inputs.push(st);
  console.log(`  parsed ${f}: ${st.lines} lines -> ${st.parsed} rows, ${st.rejected} rejected, ${st.placeBlanked} city/county blanked`);
}
flush();

// ---------------------------------------------------------------- pass 2: one Parquet file per partition
const zstd = (b: Uint8Array) => new Uint8Array(zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }));
function buildFamily(family: "name" | "num") {
  let rowsTotal = 0, dupes = 0, bytes = 0, shards = 0, biggest = { stem: "", rows: 0, bytes: 0 };
  const groups = new Map<string, { board_agency: string; license_type: string | null; status: string; n: number; chk: bigint }>();
  for (const f of fs.readdirSync(path.join(spillDir, family))) {
    const stem = f.replace(/\.jsonl$/, "");
    const seen = new Set<string>();
    const rows: SpillRow[] = [];
    for (const line of fs.readFileSync(path.join(spillDir, family, f), "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as SpillRow;
      if (seen.has(r._rk)) { dupes++; continue; }
      seen.add(r._rk); rows.push(r);
    }
    rows.sort((a, b) => (a._name < b._name ? -1 : a._name > b._name ? 1 : a._rk < b._rk ? -1 : a._rk > b._rk ? 1 : 0));
    const columnData = PARQUET_COLUMNS.map((c) => ({ name: c, type: "STRING" as const, data: rows.map((g) => g[c]) }));
    const ab = parquetWriteBuffer({ columnData, rowGroupSize: 20000, codec: "ZSTD", compressors: { ZSTD: zstd } });
    const rel = family === "name" ? namePath(sourceId, stem) : numberPath(sourceId, stem);
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), Buffer.from(ab));
    rowsTotal += rows.length; bytes += ab.byteLength; shards++;
    if (rows.length > biggest.rows) biggest = { stem, rows: rows.length, bytes: ab.byteLength };
    if (family === "name") {
      for (const r of rows) {
        const k = `${r.board_agency}|${r.license_type ?? ""}|${r.status}`;
        const g = groups.get(k) ?? { board_agency: r.board_agency!, license_type: r.license_type, status: r.status!, n: 0, chk: 0n };
        g.n++; g.chk += rowFingerprint(r); groups.set(k, g);
      }
    }
  }
  return { rowsTotal, dupes, bytes, shards, biggest, groups };
}
const nameFam = buildFamily("name");
const numFam = buildFamily("num");
fs.rmSync(spillDir, { recursive: true, force: true });
if (nameFam.rowsTotal !== numFam.rowsTotal) throw new Error(`name family has ${nameFam.rowsTotal} rows but number family has ${numFam.rowsTotal}`);

const manifest = {
  source_id: sourceId, built_at: new Date().toISOString(), rows: nameFam.rowsTotal, duplicates_dropped: nameFam.dupes,
  name_shards: nameFam.shards, number_shards: numFam.shards, codec: "ZSTD",
  parquet_bytes: { name: nameFam.bytes, number: numFam.bytes, total: nameFam.bytes + numFam.bytes },
  dropped: { schema_invalid: invalid, email_or_address: piiHits }, city_county_blanked: placeBlankedTotal,
  inputs, fingerprint_groups: [...nameFam.groups.values()].map((g) => ({ ...g, chk: g.chk.toString() })),
  parsed_before_dedupe_by_type: [...pre].map(([k, n]) => { const [board_agency, license_type] = k.split("|"); return { board_agency, license_type, n }; }),
};
fs.mkdirSync(path.join(outDir, sourceId), { recursive: true });
fs.writeFileSync(path.join(outDir, manifestPath(sourceId)), JSON.stringify(manifest));
console.log(JSON.stringify({
  source_id: sourceId, rows: manifest.rows, parsed_total: parsedTotal, duplicates_dropped: manifest.duplicates_dropped, dropped: manifest.dropped,
  city_county_blanked: placeBlankedTotal, name_shards: nameFam.shards, number_shards: numFam.shards, parquet_bytes: manifest.parquet_bytes,
  largest_name_shard: nameFam.biggest, largest_number_shard: numFam.biggest,
  bytes_per_row_both_copies: +((nameFam.bytes + numFam.bytes) / manifest.rows).toFixed(1), raw_input_bytes: inputs.reduce((s, i) => s + (i.bytes as number), 0),
}, null, 1));
