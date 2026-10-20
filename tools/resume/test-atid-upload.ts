// node --experimental-strip-types tools/resume/test-atid-upload.ts   (no network, no model call, no database; fixtures only)
// ATID on an uploaded resume (prompt AU, October 19, 2026): what a re-upload that carries an ATID does. The ATID found on an upload is never used as anything: not an identifier, not
// stored, not logged, not returned, and nothing is looked up for it. The only thing anyone learns is one word: none / match (it is the signed-in candidate's OWN) / mismatch (anything else).
// Covers the OCR text route (classifyAtidLines), the vision routes (stripAtidFromExtraction) and the wiring read from the source. NOT proved: a real PDF or image through the real
// OCR (no PDF engine or OCR runs here), the real functions deployed, a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyAtidLines, stripAtidFromExtraction, atidDisplay, atidCheckChar, atidLineBody, OWN_MATCH_MAX_DIFF } from "../../supabase/functions/_shared/resume-atid.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const src = (p: string) => fs.readFileSync(new URL(`../../supabase/functions/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const mk = (body11: string) => "ATID" + body11 + atidCheckChar(body11);
const OWN = mk("7K3MQ9XP2WD"), OTHER = mk("9A8B7C6D5E4"), OTHER2 = mk("K4TR0NX8M2V");
const PAGE = ["Jane Doe", "Senior Analyst, Example Corp", "2019-2024", "Led a team of five."].join("\n");
// malformed ATID-like strings: a wrong check character on somebody else's body (FAR from the candidate's own), and the candidate's own with its check character altered (one character off, which an OCR misread also looks like)
const bad = OTHER.slice(0, -1) + (OTHER.endsWith("0") ? "1" : "0");
const ownOneOff = OWN.slice(0, -1) + (OWN.endsWith("0") ? "1" : "0");
const hy = (a: string) => `ATID-${a.slice(4, 8)}-${a.slice(8, 12)}-${a.slice(12, 16)}`;   // the printed shape, whether or not the check character is right
const ALL_ATID_FORMS = [OWN, OTHER, OTHER2, bad].flatMap((a) => [a, hy(a), a.slice(4), hy(a).slice(5)]);

t("the signed-in candidate's OWN ATID on the upload gives 'match' and the line is left out of the text; nothing else changes", () => {
  for (const line of [atidDisplay(OWN), OWN, atidDisplay(OWN).replace(/-/g, " "), atidDisplay(OWN).toLowerCase().toUpperCase(), "AT1D-7K3M-Q9XP-2WD2", "ATID–7K3M–Q9XP–2WD2"]) {
    const r = classifyAtidLines(PAGE + "\n" + line, OWN);
    assert.equal(r.found, "match", line); assert.equal(r.stripped, 1); assert.equal(r.text, PAGE);
  }
});
t("OCR misreads of the candidate's own ATID still match (up to " + OWN_MATCH_MAX_DIFF + " of the 12 characters misread), and more than that is a mismatch", () => {
  const body = OWN.slice(4);
  const flip = (s: string, i: number, c: string) => s.slice(0, i) + c + s.slice(i + 1);
  const fmt = (b: string) => `ATID-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8)}`;
  assert.equal(classifyAtidLines(fmt(flip(body, 3, "N")), OWN).found, "match", "one character");
  assert.equal(classifyAtidLines(fmt(flip(flip(body, 3, "N"), 9, "B")), OWN).found, "match", "two characters");
  assert.equal(classifyAtidLines(fmt(flip(flip(flip(body, 3, "N"), 9, "B"), 6, "R")), OWN).found, "mismatch", "three characters");
});
t("a different valid ATID, a made-up one, one with a bad check character, and an ATID printed on a first upload (no account yet) all give the SAME word: mismatch", () => {
  const words = new Set<string>();
  for (const a of [OTHER, OTHER2, bad, mk("00000000000"), mk("ZZZZZZZZZZZ")]) { const r = classifyAtidLines(PAGE + "\n" + hy(a), OWN); words.add(r.found); assert.equal(r.text, PAGE); assert.equal(r.stripped, 1); }
  const firstUpload = classifyAtidLines(PAGE + "\n" + atidDisplay(OWN), null);
  words.add(firstUpload.found); assert.equal(firstUpload.text, PAGE);
  assert.deepEqual([...words], ["mismatch"]);
  for (const junkOwn of [undefined, "", "ATID123", 5, {}]) assert.equal(classifyAtidLines(atidDisplay(OWN), junkOwn).found, "mismatch");
});
t("a malformed ATID-like line (wrong groups, a digit run with no hyphen, wrong length) is either not an ATID line (left alone, 'none') or is read the same as any wrong ATID; never a different word", () => {
  for (const l of ["ATID Core Team Lead", "ATID-7K3M-Q9XP", "ATID 7K3M Q9XP 2WD2 5", "ATIDENTIFY"]) { const r = classifyAtidLines(PAGE + "\n" + l, OWN); assert.deepEqual([r.found, r.stripped, r.text], ["none", 0, PAGE + "\n" + l], l); }
  assert.equal(classifyAtidLines("ATID-12AB-34CD-56EF", OWN).found, "mismatch");
  assert.equal(classifyAtidLines("ATID-UUUU-UUUU-UUUU", OWN).found, "mismatch", "letters outside the alphabet still read as a wrong ATID");
});
t("no ATID on the upload gives 'none' and the text comes back as the very same string; an ATID inside a sentence is left alone", () => {
  const same = classifyAtidLines(PAGE, OWN); assert.ok(same.text === PAGE); assert.deepEqual([same.found, same.stripped], ["none", 0]);
  for (const s of [`My ATID is ${atidDisplay(OWN)} please write to me`, `Reference ${atidDisplay(OTHER)}.`]) { const r = classifyAtidLines(PAGE + "\n" + s, OWN); assert.equal(r.found, "none"); assert.equal(r.text, PAGE + "\n" + s); }
  assert.deepEqual(classifyAtidLines("", OWN), { text: "", stripped: 0, found: "none" });
  for (const x of [undefined, null, 5] as any[]) assert.equal(classifyAtidLines(x, OWN).found, "none");
});
t("several ATID lines on one upload: any wrong one makes the word mismatch, otherwise match; every such line is left out", () => {
  const r = classifyAtidLines([PAGE, atidDisplay(OWN), "footer", atidDisplay(OTHER)].join("\n"), OWN);
  assert.deepEqual([r.found, r.stripped, r.text], ["mismatch", 2, [PAGE, "footer"].join("\n")]);
  const r2 = classifyAtidLines([PAGE, atidDisplay(OWN), atidDisplay(OWN)].join("\n"), OWN);
  assert.deepEqual([r2.found, r2.stripped, r2.text], ["match", 2, PAGE]);
});
t("the detected value is in nothing that comes back: the result has only text, stripped and found, and the one word is the whole report (checked for every wrong ID and every typed form)", () => {
  let checked = 0;
  for (const a of [OWN, OTHER, OTHER2, bad]) for (const own of [OWN, null]) for (const line of [hy(a), a]) {
    const r = classifyAtidLines(PAGE + "\n" + line, own);
    assert.deepEqual(Object.keys(r).sort(), ["found", "stripped", "text"]);
    assert.equal(r.stripped, 1, line);   // it is an ATID line, so it was taken out
    const blob = JSON.stringify(r);
    for (const x of ALL_ATID_FORMS) assert.equal(blob.toUpperCase().includes(x.toUpperCase()), false, "leaked " + x);
    assert.ok(["none", "match", "mismatch"].includes(r.found)); checked++;
  }
  assert.equal(checked, 16);
});
t("a misread of the candidate's own ATID (the OCR is a camera, not a copy) is still 'match' even when its check character no longer fits; the tolerance is only ever against the candidate's own", () => {
  assert.equal(classifyAtidLines(hy(ownOneOff), OWN).found, "match");
  assert.equal(classifyAtidLines(hy(ownOneOff), OTHER).found, "mismatch", "against anyone else's ATID it is just wrong");
  assert.equal(classifyAtidLines(hy(ownOneOff), null).found, "mismatch");
});
t("the word for a wrong ID is identical for every wrong ID: it carries no hint of whose it is or whether it exists (same word for 200 random ATIDs, valid or not)", () => {
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; const words = new Set<string>();
  for (let n = 0; n < 200; n++) {
    let b = ""; for (let i = 0; i < 11; i++) b += A[Math.floor(rnd() * 32)];
    const valid = "ATID" + b + atidCheckChar(b); const a = n % 2 ? valid : valid.slice(0, 15) + A[Math.floor(rnd() * 32)];
    if (a === OWN) continue;
    words.add(classifyAtidLines(hy(a), OWN).found);
  }
  assert.deepEqual([...words], ["mismatch"]);
});

// ---------- the vision routes: the same rule on what the model sent back ----------
const EXTRACTION = () => ({
  printed_header: "Jane Doe\nAustin, TX",
  work_history: [{ company: "Acme", title: "Analyst", job_responsibilities: "Built reports\nLed a team", start_date: "2019-01", end_date: "2022-03" }],
  education: [], certifications: [], skills: ["SQL", "Excel"],
  freeform: [{ section_type: "additional_info", heading: "Notes", content: "Volunteer work" }],
});
t("vision: an extraction with no ATID line is returned unchanged (deep equal) with the word none", () => {
  const e = EXTRACTION(), copy = structuredClone(e); const r = stripAtidFromExtraction(e, OWN);
  assert.deepEqual(e, copy); assert.deepEqual(r, { stripped: 0, found: "none" });
});
t("vision: an ATID line in a section, in a job's text, in a skills list and in the header is taken out; a section left empty by it is dropped; the word follows the own/other rule", () => {
  for (const [atid, word] of [[OWN, "match"], [OTHER, "mismatch"], [bad, "mismatch"]] as const) {
    const e: any = EXTRACTION();
    e.freeform.push({ section_type: "other", heading: "", content: hy(atid) });
    e.freeform.push({ section_type: "other", heading: hy(atid), content: "" });
    e.work_history[0].job_responsibilities += "\n" + hy(atid);
    e.skills.push(hy(atid)); e.printed_header += "\n" + hy(atid);
    const r = stripAtidFromExtraction(e, OWN);
    assert.equal(r.found, word); assert.equal(r.stripped, 5);
    assert.deepEqual(e, EXTRACTION(), "back to exactly the extraction without the ATID lines");
    assert.equal(JSON.stringify(e).includes(atid.slice(4, 12)), false);
  }
});
t("vision: a sentence that contains an ATID is left alone; mixed own and other ATID lines give mismatch; the result carries no value", () => {
  const e: any = EXTRACTION(); e.freeform[0].content = `Reach me with ${atidDisplay(OWN)} any time`;
  assert.deepEqual(stripAtidFromExtraction(e, OWN), { stripped: 0, found: "none" }); assert.equal(e.freeform[0].content, `Reach me with ${atidDisplay(OWN)} any time`);
  const f: any = EXTRACTION(); f.skills.push(atidDisplay(OWN)); f.skills.push(atidDisplay(OTHER));
  const r = stripAtidFromExtraction(f, OWN); assert.deepEqual(Object.keys(r).sort(), ["found", "stripped"]); assert.equal(r.found, "mismatch");
  assert.equal(stripAtidFromExtraction(null, OWN).found, "none"); assert.equal(stripAtidFromExtraction("x", OWN).found, "none");
});
t("atidLineBody is the only reader of a line and returns only the 12 folded characters of an ATID-shaped line (null for anything else)", () => {
  assert.equal(atidLineBody(atidDisplay(OWN)), OWN.slice(4)); assert.equal(atidLineBody("hello"), null); assert.equal(atidLineBody("x".repeat(80)), null);
});

// ---------- wiring (read from the source) ----------
const RAS = src("rasterize-pdf-page/index.ts"), UP = src("upload-resume/index.ts"), GET = src("get-resume-extraction/index.ts");
t("rasterize-pdf-page: gets the candidate's own ATID from the caller (nothing else), checks it is a stored ATID, answers with the one word only when a line was found, in the OCR route and in the vision route", () => {
  assert.ok(RAS.includes("own_atid }") || RAS.includes(", own_atid }"));
  assert.ok(RAS.includes('const ownAtid: string | null = typeof own_atid === "string" && atidIsStored(own_atid) ? own_atid : null;'));
  assert.ok(RAS.includes("classifyAtidLines(ocrText, ownAtid)") && RAS.includes("stripAtidFromExtraction(extraction, ownAtid)"));
  assert.ok(RAS.includes('...(atidFound !== "none" ? { atid_check: atidFound } : {}),'));
  assert.ok(/if \(usedVision\) \{[\s\S]*stripAtidFromExtraction\(extraction, ownAtid\)/.test(RAS), "the vision route, including an OCR escalation to vision, is covered");
  assert.equal([...noComments(RAS).matchAll(/atid_check/g)].length, 1, "the only thing returned about it");
});
t("upload-resume: reads ONLY the signed-in candidate's own ATID by their own candidate id; hands it to rasterize-pdf-page; keeps one word per page; stores one word on the document; returns one word", () => {
  const fnText = (name: string) => { const i = UP.indexOf(`async function ${name}(`); return UP.slice(i, UP.indexOf("\n}\n", i) + 3); };
  const load = fnText("loadOwnAtid");
  assert.ok(load.includes('.from("candidates").select("atid").eq("id", candidateId).maybeSingle()'));
  assert.equal([...noComments(UP).matchAll(/\.from\("candidates"\)\.select\("atid"\)/g)].length, 1, "the only read of an ATID column in the whole function");
  assert.ok(UP.includes("body.own_atid = opts.ownAtid;") && UP.includes("ownAtid: opts.ownAtid"));
  assert.ok(UP.includes('if (atidWord === "match" || atidWord === "mismatch") timing.atid = atidWord;'));
  assert.ok(UP.includes('update({ atid_on_upload: atidOnUpload })') && UP.includes('update({ atid_on_upload: imageAtidWord })'));
  assert.equal([...noComments(UP).matchAll(/atid_on_upload/g)].length >= 4, true);
});
t("upload-resume: the helper that picks the word (any mismatch wins, then match, else none) behaves, and the loader returns the account's ATID or null and never throws", async () => {
  const wordFor = new Function("return " + UP.slice(UP.indexOf("function atidWordFor("), UP.indexOf("\n}\n", UP.indexOf("function atidWordFor(")) + 3).replace("function atidWordFor(pages: Array<{ timing: { atid?: string } | null }>): AtidFound", "function atidWordFor(pages)").replace('let out: AtidFound = "none";', 'let out = "none";'))();
  assert.equal(wordFor([]), "none"); assert.equal(wordFor([{ timing: null }, { timing: {} }]), "none");
  assert.equal(wordFor([{ timing: { atid: "match" } }, { timing: {} }]), "match");
  assert.equal(wordFor([{ timing: { atid: "match" } }, { timing: { atid: "mismatch" } }, { timing: { atid: "match" } }]), "mismatch");
  const loadSrc = UP.slice(UP.indexOf("async function loadOwnAtid("), UP.indexOf("\n}\n", UP.indexOf("async function loadOwnAtid(")) + 3).replace("(supabase: any, candidateId: unknown): Promise<string | null>", "(supabase, candidateId)");
  const loadOwnAtid = new Function("return " + loadSrc)();
  const calls: string[] = [];
  const sb = (data: any, boom = false) => ({ from: (tbl: string) => ({ select: (c: string) => ({ eq: (k: string, v: string) => ({ maybeSingle: async () => { calls.push(`${tbl}.${c}.${k}=${v}`); if (boom) throw new Error("x"); return { data }; } }) }) }) });
  assert.equal(await loadOwnAtid(sb({ atid: OWN }), "cid-1"), OWN); assert.deepEqual(calls, ["candidates.atid.id=cid-1"], "one read, by the candidate's own id, nothing else");
  assert.equal(await loadOwnAtid(sb({ atid: OWN }), null), null); assert.equal(await loadOwnAtid(sb({ atid: OWN }), ""), null); assert.equal(calls.length, 1, "no candidate, no read");
  assert.equal(await loadOwnAtid(sb(null), "x"), null); assert.equal(await loadOwnAtid(sb({ atid: 5 }), "x"), null); assert.equal(await loadOwnAtid(sb({}, true), "x"), null);
});
t("no lookup of an uploaded ATID anywhere: neither function nor the shared helper queries by anything found on an upload (the helper imports nothing; the only candidates read is the caller's own by id)", () => {
  const helper = noComments(src("_shared/resume-atid.ts"));
  assert.equal(/^\s*import\b/m.test(helper), false); assert.equal(/fetch\(|supabase|\.rpc\(|\.from\(/.test(helper), false);
  for (const [name, text] of [["rasterize", RAS], ["upload", UP]] as const) {
    const code = noComments(text);
    assert.equal(/atid_registry|\.from\("atid|atid=eq\.|atid_employer_visible|employer_lookup/.test(code), false, name + " never queries the registry or by an ATID value");
  }
});
t("nothing logs or returns the detected value: every ATID log line interpolates only a page number, a document id or an error text; no response field carries a value", () => {
  for (const [name, text] of [["rasterize", RAS], ["upload", UP]] as const) {
    for (const m of text.matchAll(/console\.log\(`[^`]*ATID[^`]*`\)/g)) {
      const vars = [...m[0].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
      for (const v of vars) assert.match(v, /^(pageNum|docId|String\(stripErr\)|String\(visionStripErr\))$/, name + ": " + m[0].slice(0, 90));
    }
  }
  assert.equal(/atid_on_upload: (?!imageAtidWord|atidOnUpload)/.test(noComments(UP).replace(/update\(\{ atid_on_upload: (atidOnUpload|imageAtidWord) \}\)/g, "")), false);
});
t("get-resume-extraction passes the word to the page (and nothing else about an ATID); the page note shows only for 'match' and 'mismatch'", () => {
  assert.ok(GET.includes('supersedes_document_id, atid_on_upload";'));
  assert.equal([...noComments(GET).matchAll(/atid/gi)].length, 1);
});
t("OCR-only design confirmed: neither the OCR route nor the vision route reads a PDF's metadata (Keywords, Info dictionary, XMP): no such call or word exists in the code of either function", () => {
  for (const [name, text] of [["rasterize", RAS], ["upload", UP]] as const) {
    assert.equal(/getMetaData|setMetaData|Keywords|\/Info\b|(?<![A-Za-z_])info:|XMP|pdfinfo|metadata\(/i.test(noComments(text)), false, name);
  }
});
t("no JSON import exists: no file input accepts JSON, upload-resume's accepted types are images and PDF only, and basics.applitrustId is only ever WRITTEN by the export", () => {
  assert.equal(/ACCEPTED_MIME_TYPES[^\n]*json/i.test(UP), false);
  const accept = UP.match(/ACCEPTED_MIME_TYPES[\s\S]{0,400}?\]/); assert.ok(accept); assert.equal(/json/i.test(accept![0]), false);
  const page = fs.readFileSync(new URL("../../candidate.html", import.meta.url), "utf8");
  for (const m of page.matchAll(/type="file"[^>]*accept="([^"]*)"/g)) assert.equal(/json/i.test(m[1]), false, m[1]);
  assert.equal([...page.matchAll(/applitrustId/g)].length, 1, "one write in buildDataExport, no read");
  assert.ok(page.includes("applitrustId: profile.atid || undefined,"));
  assert.equal(/JSON\.parse\([^)]*(reader|FileReader|file)/i.test(page), false);
});

let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
