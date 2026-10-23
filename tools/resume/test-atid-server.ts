// node --experimental-strip-types tools/resume/test-atid-server.ts   (no network, no model call, no database; reads the source files)
// ATID (October 19, 2026): the server functions that return the signed-in candidate's OWN atid, and the proof by reading that it reaches nobody else.
// STATIC: it proves what the code selects and returns; it does not run the functions (no live database here).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("../../supabase/", import.meta.url);
const rd = (p: string) => fs.readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const FIVE = ["check-login-status", "check-verification-status", "confirm-login", "confirm-verification", "resolve-session"];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

for (const fn of FIVE) {
  t(`${fn}: the candidates select asks for atid and the JSON response carries atid`, () => {
    const src = stripComments(rd(`functions/${fn}/index.ts`));
    const sel = [...src.matchAll(/rest\/v1\/candidates\?[^`"]*select=([^`"&]*)/g)].map((m) => m[1]);
    assert.ok(sel.some((s) => s.split(",").includes("atid")), "select list has atid: " + sel.join(" | ").slice(0, 120));
    assert.ok(/\n\s+atid: (candidate\.atid \?\? null|candidateAtid),/.test(src), "response field atid");
  });
  t(`${fn}: AR: also selects and returns atid_employer_visible, as a real boolean that is false unless the column is exactly true`, () => {
    const src = stripComments(rd(`functions/${fn}/index.ts`));
    const sel = [...src.matchAll(/rest\/v1\/candidates\?[^`"]*select=([^`"&]*)/g)].map((m) => m[1]);
    assert.ok(sel.some((s) => s.split(",").includes("atid_employer_visible")));
    assert.ok(/\n\s+atid_employer_visible: (candidate\.atid_employer_visible === true|candidateAtidEmployerVisible),/.test(src));
  });
}
t("set-discoverable: atid_employer_visible is written only when the caller sends a real boolean, and the reply carries the saved value (older callers leave it alone)", () => {
  const src = stripComments(rd("functions/set-discoverable/index.ts"));
  assert.ok(src.includes('if (typeof atid_employer_visible === "boolean") patch.atid_employer_visible = atid_employer_visible;'));
  assert.ok(src.includes("atid_employer_visible: rows[0].atid_employer_visible === true"));
  assert.ok(src.indexOf("authGateCandidate(req, authBody)") < src.indexOf("atid_employer_visible"), "the candidate's own session is checked before anything is read from the body");
});
t("get-customization: the atid is selected from the candidate row, returned BESIDE the resume (not inside it), and only for a candidate session", () => {
  const src = stripComments(rd("functions/get-customization/index.ts"));
  assert.ok(/candidates\?id=eq\.\$\{candidateId\}&select=[^`]*,atid`/.test(src));
  assert.ok(/!isServiceCaller\(req\) && ackRow && typeof ackRow\.atid === "string"/.test(src));
  assert.ok(/return json\(\{ ok: true, resume, edit_ack: \{[^}]*\}, atid \}\);/.test(src), "atid is a sibling of resume");
});

// ---------- nothing else mentions it ----------
// AR (October 19, 2026) added the employer lookup and the comparison document on purpose: check-existence, send-lookup-confirmation, candidate-comparison-requests; and the
// candidate's own save path set-discoverable. Every other function must still never mention it.
const EMPLOYER_SIDE_AR = ["check-existence", "send-lookup-confirmation", "candidate-comparison-requests"];
// AU added: set-atid-preferences (the candidate's own save path for the four ATID choices), upload-resume and get-resume-extraction (the one-word note about an ATID on an upload).
const ALLOWED_FUNCTIONS = new Set([...FIVE, "get-customization", "rasterize-pdf-page", "set-discoverable", "set-atid-preferences", "upload-resume", "get-resume-extraction", ...EMPLOYER_SIDE_AR]);
t("only the allowed function files mention atid (the 5 session functions, get-customization, rasterize-pdf-page, set-discoverable, and the 3 employer-side AR functions) plus the shared helper", () => {
  const dirs = fs.readdirSync(new URL("functions/", root), { withFileTypes: true }).filter((d) => d.isDirectory());
  const hits: string[] = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(new URL(`functions/${d.name}/`, root))) {
      if (!/\.(ts|js|json|html)$/.test(f) || !fs.statSync(new URL(`functions/${d.name}/${f}`, root)).isFile()) continue;
      const src = fs.readFileSync(new URL(`functions/${d.name}/${f}`, root), "utf8");
      if (/atid/i.test(src)) hits.push(`${d.name}/${f}`);
    }
  }
  const unexpected = hits.filter((h) => !ALLOWED_FUNCTIONS.has(h.split("/")[0]) && !h.startsWith("_shared/"));
  assert.deepEqual(unexpected, [], "unexpected: " + unexpected.join(", "));
  const shared = fs.readdirSync(new URL("functions/_shared/", root)).filter((f) => fs.statSync(new URL(`functions/_shared/${f}`, root)).isFile()).filter((f) => /atid/i.test(fs.readFileSync(new URL(`functions/_shared/${f}`, root), "utf8")));
  assert.deepEqual(shared, ["resume-atid.ts"]);
  console.log("      files that mention it: " + hits.sort().join(", "));
});
t("every other employer-facing function never mentions atid: employer-*, send-* except send-lookup-confirmation, every email sender, staff-*", () => {
  const dirs = fs.readdirSync(new URL("functions/", root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const employerFacing = dirs.filter((n) => /^employer|comparison|check-existence|^send-|email|notify|^staff-/.test(n) && !EMPLOYER_SIDE_AR.includes(n));
  assert.ok(employerFacing.length >= 8, "found " + employerFacing.length);
  for (const n of employerFacing) assert.equal(/atid/i.test(rd(`functions/${n}/index.ts`)), false, n);
  console.log("      checked " + employerFacing.length + " functions");
});
t("no migration other than the two ATID ones mentions atid: assemble_customized_resume, the comparison snapshots and the employer views are unchanged", () => {
  const dir = new URL("migrations/", root);
  const hits = fs.readdirSync(dir).filter((f) => /atid/i.test(fs.readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(hits, ["20261019010000_atid.sql", "20261019020000_atid_employer_visible.sql", "20261019030000_atid_export_prefs.sql", "20261019040000_atid_upload_notice.sql"]);
});
t("no function logs the atid: no console line in the 7 files interpolates or names it", () => {
  for (const n of [...ALLOWED_FUNCTIONS]) {
    const src = stripComments(rd(`functions/${n}/index.ts`));
    for (const m of src.matchAll(/console\.(?:log|error|warn|info)\(([^;\n]*)/g)) {
      // BI (October 22, 2026): the ONE allowed exception is the diagnostic line of assemble_plain_document: it names the switch and carries three variables that hold only a reason word and two booleans
      const args = m[1].replace(/ATID line strip(ped| FAILED)/g, "").replace(/plain document ATID - decision=\$\{atidDecision\} atid_employer_visible=\$\{atidVisible\} atid_valid=\$\{atidValid\}/, "");
      assert.equal(/atid/i.test(args), false, n + ": " + m[0].slice(0, 100));
    }
  }
});
t("the strip log lines carry only the page number (no value, no account)", () => {
  const src = rd("functions/rasterize-pdf-page/index.ts");
  for (const m of src.matchAll(/console\.log\(`[^`]*ATID line strip[^`]*`\)/g)) assert.equal(/candidate|email|session/i.test(m[0]), false, m[0]);
});
t("the ATID migration does not touch an existing function: it creates only atid_/trg_candidates_atid_ functions", () => {
  const src = rd("migrations/20261019010000_atid.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const fns = [...src.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
  assert.ok(fns.length >= 9);
  for (const f of fns) assert.match(f, /^(atid_|trg_candidates_atid_)/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
