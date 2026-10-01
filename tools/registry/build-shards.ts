// Builds the sharded Parquet files for a file-based source from its ORIGINAL downloaded files (same parsers the DB ingest used).
//   node tools/registry/build-shards.ts <source: ca-dca|mi-lara> <outDir> <inputDir> <file> [file ...]
// Output: <outDir>/<source>/name/xx.parquet, <outDir>/<source>/num/hh.parquet, <outDir>/<source>/manifest.json, plus a size report.
// Codec is ZSTD (level 19) -- measured on the real California data: snappy 21.7 MB, gzip 14.1 MB, zstd 13.4 MB for the same 120k rows.
// Before writing, every record is checked against the common schema and against the personal-data gate: no e-mail address and no
// street address in any text field (the parsers already blank street addresses found in city/county fields).
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";
import type { IngestLicense } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { licenseProblems } from "../../supabase/functions/_shared/registry/schema.ts";
import { nameKey, containsEmail, looksLikeStreetAddress } from "../../supabase/functions/_shared/registry/normalize.ts";
import { PARQUET_COLUMNS, nameShardKeyFor, nameShardStem, numberShardStem, namePath, numberPath, manifestPath } from "../../supabase/functions/_shared/registry/shard.ts";
import type { ShardRow } from "../../supabase/functions/_shared/registry/shard.ts";

const [sourceId, outDir, inDir, ...files] = process.argv.slice(2);
if (!sourceId || !outDir || !inDir || files.length === 0) { console.error("usage: build-shards.ts <ca-dca|mi-lara> <outDir> <inputDir> <file...>"); process.exit(2); }

const parse = (name: string): IngestLicense[] => {
  const buf = fs.readFileSync(path.join(inDir, name));
  if (sourceId === "ca-dca") return parseCaDcaTsv(buf.toString("latin1")).rows;
  if (sourceId === "mi-lara") return parseMichiganTsv(buf.toString("utf8")).rows;
  throw new Error("unknown source " + sourceId);
};

const rows: Array<ShardRow & { _name: string; _rk: string }> = [];
const seen = new Set<string>();
const inputs: Array<{ file: string; sha256: string; bytes: number; rows: number }> = [];
let piiHits = 0, invalid = 0, dupes = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(inDir, f));
  const parsed = parse(f);
  inputs.push({ file: f, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length, rows: parsed.length });
  for (const p of parsed) {
    const r = p.record;
    if (licenseProblems(r).length) { invalid++; continue; }
    // E-mail anywhere in a text field -> never stored. Street addresses are checked only where a PLACE belongs (city / county): business NAMES
    // such as "LENSCRAFTERS #083" or "130 South Ave LLC" legitimately look like addresses and must not be dropped.
    const texts = [r.license_holder_name, r.license_number, r.license_type, ...Object.values(r.details ?? {})];
    const place = [r.details?.city, r.details?.county];
    if (texts.some((t) => containsEmail(t)) || place.some((t) => typeof t === "string" && looksLikeStreetAddress(t))) { piiHits++; continue; }
    const key = `${sourceId}|${p.record_key}`;
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    rows.push({
      _name: nameKey(r.license_holder_name), _rk: p.record_key,
      last_key: p.last_name ? nameKey(p.last_name) : null, first_key: p.first_name ? nameKey(p.first_name) : null,
      license_holder_name: r.license_holder_name, holder_kind: r.holder_kind, license_number: r.license_number, license_type: r.license_type,
      status: r.status, status_raw: r.status_raw, issue_date: r.issue_date, expiration_date: r.expiration_date, state: r.state,
      board_agency: r.board_agency, source: r.source, details: JSON.stringify(r.details ?? {}),
    });
  }
}
console.log(`rows kept=${rows.length} schema_invalid=${invalid} dropped_for_email_or_address=${piiHits} duplicate_keys=${dupes}`);

const zstd = (b: Uint8Array) => new Uint8Array(zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }));
function writeShard(rel: string, group: typeof rows): number {
  group.sort((a, b) => (a._name < b._name ? -1 : a._name > b._name ? 1 : a._rk < b._rk ? -1 : 1));
  const columnData = PARQUET_COLUMNS.map((c) => ({ name: c, type: "STRING" as const, data: group.map((g) => g[c]) }));
  const ab = parquetWriteBuffer({ columnData, rowGroupSize: 20000, codec: "ZSTD", compressors: { ZSTD: zstd } });
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, Buffer.from(ab));
  return ab.byteLength;
}

const byName = new Map<string, typeof rows>(), byNum = new Map<string, typeof rows>();
for (const r of rows) {
  const n = nameShardStem(nameShardKeyFor({ holder_kind: r.holder_kind!, last_key: r.last_key, name_key: r._name }));
  const m = numberShardStem(r.license_number!);
  (byName.get(n) ?? byName.set(n, []).get(n)!).push(r);
  (byNum.get(m) ?? byNum.set(m, []).get(m)!).push(r);
}
let nameBytes = 0, numBytes = 0, maxName = { stem: "", rows: 0, bytes: 0 }, maxNum = { stem: "", rows: 0, bytes: 0 };
for (const [stem, g] of byName) { const b = writeShard(namePath(sourceId, stem), g); nameBytes += b; if (g.length > maxName.rows) maxName = { stem, rows: g.length, bytes: b }; }
for (const [stem, g] of byNum) { const b = writeShard(numberPath(sourceId, stem), g); numBytes += b; if (g.length > maxNum.rows) maxNum = { stem, rows: g.length, bytes: b }; }

const manifest = {
  source_id: sourceId, built_at: new Date().toISOString(), rows: rows.length, name_shards: byName.size, number_shards: byNum.size,
  codec: "ZSTD", parquet_bytes: { name: nameBytes, number: numBytes, total: nameBytes + numBytes }, inputs,
};
fs.mkdirSync(path.join(outDir, sourceId), { recursive: true });
fs.writeFileSync(path.join(outDir, manifestPath(sourceId)), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({
  ...manifest, inputs: undefined, largest_name_shard: maxName, largest_number_shard: maxNum,
  bytes_per_row_both_copies: +((nameBytes + numBytes) / rows.length).toFixed(1), raw_input_bytes: inputs.reduce((s, i) => s + i.bytes, 0),
}, null, 1));
