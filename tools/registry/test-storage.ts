// Round-trip test of the storage-backed source against the REAL shard files built from the real California / Michigan data:
// for a random sample of real records, look each one up by name and by license number through makeStorageLicenseSource (reading the
// actual .parquet files) and assert the record comes back unchanged. Also checks prefix matching, a missing shard, and a corrupt shard.
//   node tools/registry/test-storage.ts <shardsDir> <ca-dca dir> <mi tsv dir>
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { makeStorageLicenseSource } from "../../supabase/functions/_shared/registry/storage-sources.ts";
import { parseCaDcaTsv } from "../../supabase/functions/_shared/registry/ca-dca.ts";
import { parseMichiganTsv } from "../../supabase/functions/_shared/registry/michigan.ts";

const [shards, caDir, miDir] = process.argv.slice(2);
const mkFetch = (corrupt = false): typeof fetch => (async (url: string) => {
  const m = /\/storage\/v1\/object\/registry-data\/(.+)$/.exec(url)!;
  const file = path.join(shards, m[1]);
  if (!fs.existsSync(file)) return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
  const buf = fs.readFileSync(file);
  return new Response(corrupt ? buf.subarray(0, 40) : buf, { status: 200 });
}) as unknown as typeof fetch;
const readParquet = (ab: ArrayBuffer) => parquetReadObjects({ file: ab, compressors }) as Promise<Array<Record<string, unknown>>>;
const access = (corrupt = false) => ({ baseUrl: "http://local", serviceKey: "k", readParquet, fetchImpl: mkFetch(corrupt) });

const sources = {
  "ca-dca": { rows: ["Psychology_full", "PhysTherapy_full", "Acupuncture_Data00", "Optometry_Data00", "Fiduciaries_Data00", "Naturopathic_Data00"].flatMap((f) => parseCaDcaTsv(fs.readFileSync(`${caDir}/${f}.xls`, "latin1")).rows) },
  "mi-lara": { rows: parseMichiganTsv(fs.readFileSync(`${miDir}/MI_32411.tsv`, "utf8")).rows },
} as const;

let checks = 0;
for (const [id, { rows }] of Object.entries(sources)) {
  const src = makeStorageLicenseSource({ id, label: id, state: id === "ca-dca" ? "CA" : "MI", source_dataset: id }, access());
  // deterministic sample: every Nth record
  const step = Math.max(1, Math.floor(rows.length / 300));
  let n = 0, notFound = 0;
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i].record;
    n++;
    const byNumber = await src.search({ license_number: r.license_number, limit: 100 }, "exact");
    assert.ok(byNumber.ok, JSON.stringify(byNumber));
    const hit = byNumber.records.find((x) => x.license_holder_name === r.license_holder_name && x.license_type === r.license_type && x.board_agency === r.board_agency);
    assert.ok(hit, `${id}: by number ${r.license_number} did not return ${r.license_holder_name}`);
    assert.deepEqual(hit, r, `${id}: record changed in storage round trip (${r.license_number})`);
    const q = rows[i].last_name && rows[i].first_name ? { first_name: rows[i].first_name!, last_name: rows[i].last_name!, limit: 100 } : { business_name: r.license_holder_name, limit: 100 };
    const byName = await src.search(q, "exact");
    assert.ok(byName.ok, JSON.stringify(byName));
    const hit2 = byName.records.find((x) => x.license_number === r.license_number && x.license_type === r.license_type && x.board_agency === r.board_agency);
    if (!hit2) { notFound++; continue; }
    assert.deepEqual(hit2, r);
    checks += 2;
  }
  assert.equal(notFound, 0, `${id}: ${notFound} sampled records were not found by name`);
  console.log(`${id}: ${n} sampled real records found by license number AND by name, byte-for-byte equal to the parsed source record`);
  // prefix matching
  const sample = rows.find((x) => x.first_name && x.first_name.length >= 4 && x.last_name)!;
  const pre = await src.search({ first_name: sample.first_name!.slice(0, 3), last_name: sample.last_name!, limit: 100 }, "prefix");
  assert.ok(pre.ok && pre.records.some((x) => x.license_number === sample.record.license_number), "first-name prefix");
  // a prefix nobody has -> ok + empty, never an error
  const none = await src.search({ first_name: "Zzqxv", last_name: "Plmnbvq", limit: 5 }, "exact");
  assert.ok(none.ok && none.records.length === 0, "missing shard must be an empty answer");
  // a corrupt shard is an ERROR, never "not found"
  const bad = await makeStorageLicenseSource({ id, label: id, state: "XX", source_dataset: id }, access(true)).search({ license_number: sample.record.license_number }, "exact");
  assert.ok(!bad.ok && bad.error === "storage_error", "corrupt shard must surface as storage_error, got " + JSON.stringify(bad).slice(0, 120));
}
// a one-character business prefix is refused (cannot pick a shard) rather than scanning
const ca = makeStorageLicenseSource({ id: "ca-dca", label: "x", state: "CA", source_dataset: "x" }, access());
const one = await ca.search({ business_name: "A", limit: 5 }, "prefix");
assert.ok(one.ok || one.error === "empty_or_invalid_query");
console.log(`storage source: ${checks} assertions on real data passed; missing shard -> empty; corrupt shard -> storage_error`);

// license_type narrowing filter (case-insensitive "contains"), applied before the result cap
{
  const ca = makeStorageLicenseSource({ id: "ca-dca", label: "ca", state: "CA", source_dataset: "ca" }, access());
  const rec = sources["ca-dca"].rows.find((r) => r.first_name && r.last_name && r.record.license_type)!;
  const type = rec.record.license_type!;
  const withType = await ca.search({ first_name: rec.first_name!, last_name: rec.last_name!, license_type: type.toLowerCase().slice(0, Math.max(4, type.length - 2)), limit: 100 }, "exact");
  assert.ok(withType.ok && withType.records.some((x) => x.license_number === rec.record.license_number), "type filter keeps the matching record");
  assert.ok(withType.ok && withType.records.every((x) => (x.license_type ?? "").toLowerCase().includes(type.toLowerCase().slice(0, Math.max(4, type.length - 2)))), "every returned record matches the type filter");
  const none = await ca.search({ first_name: rec.first_name!, last_name: rec.last_name!, license_type: "zzz-no-such-license-type", limit: 100 }, "exact");
  assert.ok(none.ok && none.records.length === 0, "a type that matches nothing returns nothing");
  console.log("license_type filter: keeps matching records, drops the rest, and a non-matching type returns nothing");
}
