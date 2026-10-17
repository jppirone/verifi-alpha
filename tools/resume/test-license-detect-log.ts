// node --experimental-strip-types tools/resume/test-license-detect-log.ts   (no dependencies, no network, no model call)
// AP9L: the diagnostic log lines of detect-license-mentions never throw and never change the result.
//  - the helper in _shared/license-detect-log.ts survives empty, non JSON, very long and hostile input, and a sink that throws
//  - validateState (changed only by two extra fields, rule and detail) returns the same state and evidence as master on a table of cases
//  - callModel (given a stubbed fetch) returns the same result as master for an empty answer, a non JSON answer, a huge answer and a real answer,
//    with and without the diagnostic object, and the log lines it produces contain no key, token or header
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { clip, logRawAnswer, logItemDecision, RAW_ANSWER_MAX, INPUT_SNIPPET_MAX } from "../../supabase/functions/_shared/license-detect-log.ts";

let n = 0; const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const tests: Array<[string, () => void | Promise<void>]> = [];
const SRC = "supabase/functions/detect-license-mentions/index.ts";
const here = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
let master = "";
try { master = execFileSync("git", ["show", "origin/master:" + SRC], { encoding: "utf8" }).replace(/\r\n/g, "\n"); } catch { master = ""; }
assert.ok(master.includes("function validateState("), "could not read master's copy with git show origin/master (run `git fetch origin` first)");

const FAKE_KEY = "sk-ant-TEST-KEY-DO-NOT-LOG-123456";

// ---- the helper ----
t("clip: truncation flag and limits", () => {
  assert.deepEqual(clip("abc", 5), { text: "abc", truncated: false });
  assert.deepEqual(clip("abcdef", 3), { text: "abc", truncated: true });
  assert.deepEqual(clip(undefined, 3), { text: "", truncated: false });
  assert.deepEqual(clip(null, 3), { text: "", truncated: false });
});

t("logRawAnswer: empty, undefined, not JSON, very long, hostile objects: never throws and always writes at most one line", () => {
  const cases: any[] = [
    {}, { docId: "d" }, { docId: "d", ok: false, error: "malformed_detection_response", rawText: "", model: undefined },
    { docId: "d", ok: true, rawText: "this is { not json", model: "m", inputSnippet: "x" },
    { docId: "d", ok: true, rawText: "A".repeat(500000), inputSnippet: "B".repeat(500000), model: "m" },
    { docId: "d", ok: true, rawText: { toString() { throw new Error("boom"); } }, inputSnippet: { toString() { throw new Error("boom"); } } },
    { docId: "d", ok: true, locations: [null, undefined, { source: "s", value: undefined }, { source: "s", value: "Sebastian, FL" }] },
    { docId: "d", ok: true, locations: "not an array" },
    null, undefined,
  ];
  for (const c of cases) {
    const lines: string[] = [];
    assert.doesNotThrow(() => logRawAnswer(c as any, (l) => lines.push(l)));
    assert.ok(lines.length <= 1);
  }
  // a sink that throws is swallowed too
  assert.doesNotThrow(() => logRawAnswer({ docId: "d", ok: true, rawText: "x" }, () => { throw new Error("sink down"); }));
  assert.doesNotThrow(() => logItemDecision({ docId: "d", name: "n", stateReturned: "FL", accepted: true, rule: "r" }, () => { throw new Error("sink down"); }));
});

t("logRawAnswer: raw answer cut at 4000 and flagged; input cut at 1000; model name kept exactly; locations kept as strings", () => {
  const lines: string[] = [];
  logRawAnswer({ docId: "doc1", ok: true, model: "claude-sonnet-5-20260101", rawText: "R".repeat(RAW_ANSWER_MAX + 50), inputSnippet: "I".repeat(INPUT_SNIPPET_MAX + 5),
    inputKind: "application/pdf", inputBytes: 1234, locations: [{ source: "resume_documents.candidate_location", value: "Sebastian, FL" }] }, (l) => lines.push(l));
  const j = JSON.parse(lines[0].slice(lines[0].indexOf("license-detect raw ") + "license-detect raw ".length));
  assert.equal(j.raw_answer.length, RAW_ANSWER_MAX); assert.equal(j.raw_answer_truncated, true); assert.equal(j.raw_answer_chars, RAW_ANSWER_MAX + 50);
  assert.equal(j.input_text_tail.length, INPUT_SNIPPET_MAX); assert.equal(j.input_text_truncated, true);
  assert.equal(j.model, "claude-sonnet-5-20260101");
  assert.deepEqual(j.candidate_locations, [{ source: "resume_documents.candidate_location", value: "Sebastian, FL" }]);
  assert.ok(lines[0].startsWith("detect-license-mentions: doc1 license-detect raw "));
  const short: string[] = [];
  logRawAnswer({ docId: "d", ok: true, rawText: "short" }, (l) => short.push(l));
  assert.equal(JSON.parse(short[0].slice(short[0].indexOf("raw ") + 4)).raw_answer_truncated, false);
});

t("logItemDecision: state 'none' when the model returned no state; accepted or rejected; rule and values", () => {
  const lines: string[] = [];
  logItemDecision({ docId: "d", name: "Plumber", stateReturned: null, accepted: false, rule: "model_returned_no_state" }, (l) => lines.push(l));
  logItemDecision({ docId: "d", name: "Plumber", stateReturned: "FL", evidenceReturned: "FL", accepted: false, rule: "evidence_is_part_of_candidate_location_text", detail: { location: "Sebastian, FL" } }, (l) => lines.push(l));
  const a = JSON.parse(lines[0].slice(lines[0].indexOf("item ") + 5)), b = JSON.parse(lines[1].slice(lines[1].indexOf("item ") + 5));
  assert.equal(a.state_returned, "none"); assert.equal(a.result, "rejected");
  assert.equal(b.state_returned, "FL"); assert.equal(b.rule, "evidence_is_part_of_candidate_location_text"); assert.equal(b.detail.location, "Sebastian, FL");
});

// ---- validateState: same state and evidence as master ----
function loadValidate(src: string) {
  const a = src.indexOf("const STATE_BY_NAME");
  const b = src.indexOf("function normNumber(");
  assert.ok(a > 0 && b > a);
  return new Function(stripTypeScriptTypes(src.slice(a, b)) + "\nreturn validateState;")() as (s: unknown, e: unknown, l: string[]) => any;
}
const vNew = loadValidate(here), vOld = loadValidate(master);

t("validateState: state and evidence identical to master on every case; the new fields name the deciding rule", () => {
  const locs = ["Sebastian, FL", "JOHN PIRONE\nAI Solutions Consultant\nSebastian, FL jpirone@yahoo.com"];
  const states = [null, undefined, "", "FL", "fl", "XX", "TX", "IN", "OR", "CO", 5, "Florida"];
  const evs = [null, undefined, "", "F", "FL", "Plumber FL Lic #", "Plumber FL Lic # CFC1425829", "Sebastian, FL", "Florida Department of Business and Professional Regulation", "DBPR", "State of Texas Board", "Denver, CO", "Sebastian", "License #123, Indiana", "in progress"];
  const locSets = [[], locs, ["Texas"], ["Austin, TX"]];
  let cases = 0;
  for (const s of states) for (const e of evs) for (const l of locSets) {
    const o = vOld(s, e, l), w = vNew(s, e, l);
    assert.equal(w.state, o.state, JSON.stringify([s, e, l])); assert.equal(w.evidence, o.evidence, JSON.stringify([s, e, l]));
    assert.ok(typeof w.rule === "string" && w.rule.length > 0);
    assert.equal(w.rule === "accepted", w.state !== null);
    cases++;
  }
  assert.ok(cases > 500);
  // the case this log exists to settle
  assert.equal(vNew("FL", "FL", locs).rule, "evidence_is_part_of_candidate_location_text");
  assert.equal(vNew("FL", "FL", locs).state, null);
  assert.equal(vNew("FL", "Plumber FL Lic #", locs).rule, "accepted");
  assert.equal(vNew(null, null, locs).rule, "model_gave_no_state_or_no_evidence");
});

// ---- callModel: same result with and without the diagnostic object ----
function loadCall(src: string) {
  const a = src.indexOf("function normNumber(");
  const endMark = "  return { ok: true, mentions };\n}";
  const b = src.indexOf(endMark, a) + endMark.length;
  assert.ok(a > 0 && b > a);
  const js = `const ANTHROPIC_API_KEY = ${JSON.stringify(FAKE_KEY)}; const MODEL = "claude-sonnet-5";\n` + stripTypeScriptTypes(src.slice(a, b)) + "\nreturn callModel;";
  return new Function(js)() as (b64: string, mime: string, existing: any[], diag?: any) => Promise<any>;
}
const cNew = loadCall(here), cOld = loadCall(master);

const answer = (text: string | null, model = "claude-sonnet-5-X") => ({ ok: true, status: 200, json: async () => ({ model, content: text === null ? [] : [{ type: "text", text }] }), text: async () => "" });
const REAL = JSON.stringify({ license_mentions: [{ source_text: "Plumber FL Lic # CFC1425829", license_number: "CFC1425829", state: "FL", state_evidence: "FL", confidence: 0.9 }] });
const bodies: Array<[string, any]> = [
  ["empty answer (no text block)", answer(null)],
  ["empty text", answer("")],
  ["not JSON", answer("I could not find any licenses, sorry")],
  ["JSON of the wrong shape", answer('{"nope":1}')],
  ["very long answer", answer("x".repeat(300000))],
  ["real answer with state FL", answer(REAL)],
  ["fenced real answer", answer("```json\n" + REAL + "\n```")],
  ["HTTP 500", { ok: false, status: 500, json: async () => ({}), text: async () => "upstream" }],
  ["body that cannot be read", { ok: true, status: 200, json: async () => { throw new Error("stalled"); }, text: async () => "" }],
];
t("callModel: identical result to master with and without the diagnostic object, for empty / non JSON / very long / real answers", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const [name, resp] of bodies) {
      (globalThis as any).fetch = async () => resp;
      const old = await cOld("QQ==", "application/pdf", [{ id: "1", name: "Plumber", issuing_body: "", license_number: "CFC1425829" }]);
      const diag: any = {};
      const neu = await cNew("QQ==", "application/pdf", [{ id: "1", name: "Plumber", issuing_body: "", license_number: "CFC1425829" }], diag);
      const neuNoDiag = await cNew("QQ==", "application/pdf", [{ id: "1", name: "Plumber", issuing_body: "", license_number: "CFC1425829" }]);
      assert.deepEqual(neu, old, name); assert.deepEqual(neuNoDiag, old, name);
      // what was captured for the log
      const lines: string[] = [];
      logRawAnswer({ docId: "d", ok: neu.ok, error: neu.error, model: diag.model, rawText: diag.rawText, inputSnippet: String(diag.promptText ?? "").slice(-1000) }, (l) => lines.push(l));
      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes(FAKE_KEY), "a key must never appear in a log line");
      assert.ok(!/x-api-key|authorization|bearer/i.test(lines[0]), name);
    }
    // the model name is exactly the one in the response
    (globalThis as any).fetch = async () => answer(REAL, "claude-sonnet-5-20261001");
    const d: any = {}; await cNew("QQ==", "application/pdf", [], d);
    assert.equal(d.model, "claude-sonnet-5-20261001"); assert.equal(d.rawText, REAL);
    assert.ok(typeof d.promptText === "string" && d.promptText.includes("STATE RULES"));
  } finally { (globalThis as any).fetch = realFetch; }
});

t("the main flow: only log calls and the diagnostic object were added around the decisions (no other changed behavior line)", () => {
  // every line that differs from master, other than the log helper calls, must be one of the known additive edits
  const oldL = new Set(master.split("\n")), added = here.split("\n").filter((l) => !oldL.has(l));
  const allowed = [/logRaw|logItemDecision|logRawAnswer|CallDiag|diag\b|diag\./, /rule|detail/, /^\s*\/\/ AP9L/, /^\s*\/\/ rule\/detail/, /^\s*(\{|\}|\]|\)|try \{|\},?)\s*[,;]?\s*$/, /^\s*(docId|inputSnippet|source:|\{ source)/, /^\s*\],?\s*true\);?$/, /^\s*(continue;|\}|\} catch.*)$/, /^\s*\}\);\s*$/,
    /if \(m\.confidence < MIN_CONFIDENCE\) \{/, /if \(!key \|\| seen\.has\(key\)\) \{/, /^\s*const diag/, /^\s*const result = await callModel/, /^\s*if \(!result\.ok\) \{/ ];
  const odd = added.filter((l) => !allowed.some((r) => r.test(l)));
  assert.deepEqual(odd, [], "unexpected changed lines:\n" + odd.join("\n"));
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok  ", name); }
console.log(`\n${n} tests passed`);
