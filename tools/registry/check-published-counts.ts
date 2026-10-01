// Compares what we built (build manifest) with the state's OWN published license counts: every board folder on the DCA Box share ships a
// <Board>_Counts.csv listing "Agency Name, License Type Name, License Count". For each board built, this prints published vs parsed (before
// de-duplication) vs stored (after), and calls out every difference instead of rolling it into a total.
//   node tools/registry/check-published-counts.ts <manifest.json> <countsDir>
// Matching: a Counts file <X>_Counts.csv belongs to the input file(s) named <X>_Data*. Within a board, license types are matched by
// (agency, type) name; where the Counts file and the data file spell those names differently (Court Reporters, Hearing Aid Dispensers, the
// Engineers board) the board TOTAL is compared instead and the board is marked "totals only".
import fs from "node:fs";
import path from "node:path";

const [manifestFile, countsDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function readCounts(file: string): Array<{ agency: string; type: string; n: number }> {
  const raw = fs.readFileSync(file);
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
  const delim = text.split("\n")[0].includes("\t") ? "\t" : ",";
  const out: Array<{ agency: string; type: string; n: number }> = [];
  text.split(/\r?\n/).slice(1).forEach((line) => {
    if (!line.trim()) return;
    const c = line.split(delim).map((x) => x.replace(/^"|"$/g, "").trim());
    const n = Number(c[2]?.replace(/,/g, ""));
    if (!c[0] || !c[1] || !Number.isFinite(n)) return; // total / formula rows have no agency or type
    out.push({ agency: c[0], type: c[1], n });
  });
  return out;
}

const pre = new Map<string, number>(), kept = new Map<string, number>();
for (const g of manifest.parsed_before_dedupe_by_type) { const k = norm(g.board_agency) + "|" + norm(g.license_type ?? ""); pre.set(k, (pre.get(k) ?? 0) + g.n); }
for (const g of manifest.fingerprint_groups) { const k = norm(g.board_agency) + "|" + norm(g.license_type ?? ""); kept.set(k, (kept.get(k) ?? 0) + g.n); }
const inputs: Array<{ file: string; parsed: number; rejected: number }> = manifest.inputs;

let boards = 0, exactBoards = 0, pubTotal = 0, parsedTotal = 0, keptTotal = 0;
const lines: string[] = [];
for (const f of fs.readdirSync(countsDir).filter((x) => /_Counts\.csv$/i.test(x)).sort()) {
  const prefix = f.replace(/_Counts\.csv$/i, "");
  const mine = inputs.filter((i) => i.file.startsWith(prefix + "_Data"));
  if (mine.length === 0) continue; // a board that is not part of this build
  const rows = readCounts(path.join(countsDir, f));
  const pub = rows.reduce((s, r) => s + r.n, 0);
  const filesParsed = mine.reduce((s, i) => s + i.parsed, 0);
  let par = 0, kep = 0; const diffs: string[] = []; let unmatchedTypes = 0;
  for (const r of rows) {
    const k = norm(r.agency) + "|" + norm(r.type);
    if (!pre.has(k) && !kept.has(k)) unmatchedTypes++;
    const p = pre.get(k) ?? 0, s = kept.get(k) ?? 0;
    par += p; kep += s;
    if (p !== r.n && s !== r.n) diffs.push(`${r.type}: published ${r.n}, parsed ${p}, stored ${s}`);
  }
  const totalsOnly = unmatchedTypes === rows.length;
  if (totalsOnly) { par = filesParsed; kep = filesParsed; }
  boards++; pubTotal += pub; parsedTotal += par; keptTotal += kep;
  const exact = totalsOnly ? pub === filesParsed : diffs.length === 0;
  if (exact) exactBoards++;
  const verdict = totalsOnly ? (pub === filesParsed ? "totals only (type names differ): totals match" : `totals only (type names differ): DIFFER by ${filesParsed - pub}`) : diffs.length === 0 ? "every license type matches" : `${diffs.length} type(s) differ`;
  lines.push(`${prefix.padEnd(42)} published ${String(pub).padStart(8)}  parsed ${String(par).padStart(8)}  stored ${String(kep).padStart(8)}  ${verdict}${!totalsOnly && par !== kep ? `  [${par - kep} exact duplicate rows in file collapsed]` : ""}`);
  for (const d of diffs.slice(0, 5)) lines.push(`      - ${d}`);
}
console.log(lines.join("\n"));
console.log(`\n${boards} boards built; ${exactBoards} match the published counts exactly (every license type, or board total where type names differ).`);
console.log(`TOTAL published ${pubTotal.toLocaleString()} | parsed ${parsedTotal.toLocaleString()} | stored ${keptTotal.toLocaleString()}`);
