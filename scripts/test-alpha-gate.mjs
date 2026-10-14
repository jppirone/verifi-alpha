// Alpha front page gate test (prompt AP5, 2026-10-14). No network, no browser, no key. Runs the real js/alpha-gate.js in a node vm with a
// tiny fake page (document, sessionStorage, location). The real access phrase is never needed or stored here: acceptance is tested with a
// SECOND, known test phrase whose hash is swapped into an in-memory copy of the gate; the real hash is only checked for shape.
// Mutation controls run in memory (nothing on disk is touched).
//   node scripts/test-alpha-gate.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "candidate.html", "employer.html", "staff.html"];
const GATE_TAG = '<script src="js/alpha-gate.js"></script>';
const TEST_PHRASE = "fixture-test-phrase-only";   // a test fixture, NOT the access phrase
const TEST_SALT = crypto.randomBytes(16).toString("base64");
const TEST_ITER = 1000;                           // the variant uses few rounds so the test is quick
const TEST_HASH = crypto.pbkdf2Sync(TEST_PHRASE, Buffer.from(TEST_SALT, "base64"), TEST_ITER, 32, "sha256").toString("base64");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const constOf = (src, name) => (src.match(new RegExp(`${name} = "([^"]+)"`)) || [])[1];

// ---- a minimal fake page ---------------------------------------------------------------------------------------------------------------
function makeEnv(gateSource, { stored = {}, search = "?login_token=abc123&other=1" } = {}) {
  const mk = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, textContent: "", value: "", disabled: false, id: "", className: "", parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, focus() {},
  });
  const root = mk("html"), head = mk("head"), body = mk("body");
  const location = { search, href: "https://alpha.example/candidate.html" + search, pathname: "/candidate.html", hostname: "alpha.example" };
  const store = { ...stored };
  const sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const document = {
    documentElement: root, head, body,
    createElement: mk, getElementById: (id) => body.children.find((c) => c.id === id) || null, addEventListener() {},
  };
  const window = { crypto: crypto.webcrypto, location };
  const ctx = vm.createContext({ document, window, sessionStorage, TextEncoder, atob, btoa, Uint8Array, Promise, console });
  vm.runInContext(gateSource, ctx, { filename: "alpha-gate.js" });
  return { root, head, body, location, store, locationBefore: JSON.stringify(location) };
}
const formOf = (env) => env.body.children.find((c) => c.id === "alphaGate");
async function submit(env, phrase) {
  const form = formOf(env);
  if (!form) return "(no form on the page)";
  const input = form.children.find((c) => c.tag === "input"), button = form.children.find((c) => c.tag === "button");
  input.value = phrase; button.disabled = false;
  await form.listeners.submit[0]({ preventDefault() {} });
  for (let i = 0; i < 400; i++) {
    if (!env.root.attrs["data-alpha-gate"] || (!button.disabled && form.children.find((c) => c.className === "gate-msg").textContent)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return form.children.find((c) => c.className === "gate-msg").textContent;
}

// ---- the checks (take the sources so plants can be applied in memory) ------------------------------------------------------------------
async function runChecks({ gate, pages }) {
  const failures = []; let passed = 0;
  const ok = (cond, name) => { if (cond) passed++; else failures.push(name); };

  // 1. file level
  ok(/^var GATE_ENABLED = true;$/m.test(gate), "GATE_ENABLED is a single named constant at the top and is ON by default");
  ok(!/\b[a-z]{3,10}(-[a-z]{3,10}){3}\b/.test(gate), "the gate file holds no line shaped like four lowercase words joined by hyphens (no plaintext phrase)");
  const salt = constOf(gate, "SALT"), hash = constOf(gate, "HASH");
  ok(!!salt && Buffer.from(salt, "base64").length === 16 && !!hash && Buffer.from(hash, "base64").length === 32, "the gate stores a 16 byte salt and a 32 byte PBKDF2 hash (base64)");
  ok(/ITER = 310000/.test(gate), "310000 PBKDF2 rounds");
  ok(!/\blocation\b|\bhistory\b/.test(gate), "the gate never reads, writes or replaces the address (no location or history use)");
  ok(!/localStorage|document\.cookie|fetch\(|XMLHttpRequest/.test(gate), "the gate uses sessionStorage only and makes no network request");
  ok(!/\bverified\b|\bcompliant\b|\bcertified\b/i.test(gate), "no verified, compliant or certified wording");
  ok(!/—/.test(gate), "no em dash in the gate wording");

  // 2. every page loads it first in the head
  for (const name of PAGES) {
    const t = pages[name] || "";
    const head = (t.match(/<head[\s\S]*?<\/head>/i) || [""])[0] || t.slice(0, 3000);
    const gateAt = t.indexOf(GATE_TAG), firstScript = t.search(/<script\b/i);
    ok(gateAt > -1 && gateAt === firstScript && t.indexOf("</head>") > gateAt, `${name}: the gate script is the FIRST script and sits in the head`);
    ok((t.match(/alpha-gate\.js/g) || []).length === 1, `${name}: the gate script is loaded exactly once`);
  }

  // 3. behaviour (in memory variant with the known test phrase)
  const variant = gate.replace(/SALT = "[^"]+"/, `SALT = "${TEST_SALT}"`).replace(/HASH = "[^"]+"/, `HASH = "${TEST_HASH}"`).replace("ITER = 310000", `ITER = ${TEST_ITER}`);
  const e1 = makeEnv(variant);
  ok(e1.root.attrs["data-alpha-gate"] === "locked" && !!formOf(e1), "locked at load: the page is hidden behind the form");
  const texts = (formOf(e1)?.children || []).map((c) => c.textContent);
  ok(texts.includes("Applitrust alpha") && texts.includes("This is a private test site. Enter the access phrase you were given.") && texts.includes("Continue"), "the title, line and button use the agreed wording");
  const wrong = await submit(e1, "not-the-right-phrase");
  ok(wrong === "That phrase did not match." && e1.root.attrs["data-alpha-gate"] === "locked" && Object.keys(e1.store).length === 0, "a wrong phrase is refused and nothing is remembered");
  const right = await submit(e1, TEST_PHRASE);
  ok(!e1.root.attrs["data-alpha-gate"] && !formOf(e1) && e1.store.applitrust_alpha_gate === "open", "the right phrase opens the page and is remembered for the session");
  ok(JSON.stringify(e1.location) === e1.locationBefore && e1.location.search.includes("login_token=abc123"), "the address and its sign in token are untouched after the phrase is accepted");
  const e2 = makeEnv(variant, { stored: { applitrust_alpha_gate: "open", applitrust_alpha_gate_v: TEST_HASH.slice(0, 16) } });
  ok(!e2.root.attrs["data-alpha-gate"] && !formOf(e2), "an already unlocked session loads the page without asking again");
  const e2b = makeEnv(variant, { stored: { applitrust_alpha_gate: "open", applitrust_alpha_gate_v: "oldversion0000000" } });
  ok(e2b.root.attrs["data-alpha-gate"] === "locked", "a session unlocked with an older phrase is asked again");
  const e3 = makeEnv(variant.replace("var GATE_ENABLED = true;", "var GATE_ENABLED = false;"));
  ok(!e3.root.attrs["data-alpha-gate"] && e3.body.children.length === 0 && e3.head.children.length === 0, "GATE_ENABLED = false loads the page with no gate at all");
  if (process.env.ALPHA_GATE_PHRASE) {   // optional, never required: John's real phrase checked in memory only
    const real = makeEnv(gate); ok((await submit(real, process.env.ALPHA_GATE_PHRASE)) !== "That phrase did not match.", "the real phrase is accepted");
  }
  return { passed, failures };
}

// ---- run, with in-memory plants ---------------------------------------------------------------------------------------------------------
const base = { gate: read("js/alpha-gate.js"), pages: Object.fromEntries(PAGES.map((p) => [p, read(p)])) };
const dropTag = (t) => t.replace(new RegExp(GATE_TAG.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\\r?\\n"), "");
const PLANTS = [
  { name: "plant 1: the gate script missing from one page (employer.html)", expect: "fail", make: () => ({ ...base, pages: { ...base.pages, "employer.html": dropTag(base.pages["employer.html"]) } }) },
  { name: "plant 2: a plaintext phrase put in the gate file", expect: "fail", make: () => ({ ...base, gate: base.gate + "\n// plant-fake-phrase-here\n" }) },
  { name: "plant 3: the check always returns true", expect: "fail", make: () => ({ ...base, gate: base.gate.replace("return toB64(bits) === HASH;", "return true;") }) },
  { name: "plant 4: the gate shipped switched off", expect: "fail", make: () => ({ ...base, gate: base.gate.replace("var GATE_ENABLED = true;", "var GATE_ENABLED = false;") }) },
  { name: "plant 5: the gate script moved after another script (staff.html)", expect: "fail", make: () => ({ ...base, pages: { ...base.pages, "staff.html": dropTag(base.pages["staff.html"]).replace("</script>", "</script>\n" + GATE_TAG) } }) },
  { name: "plant 6: pointed at nothing (text that is not in the file)", expect: "pass", make: () => ({ ...base, gate: base.gate.replace("THIS TEXT IS NOT IN THE FILE", "x") }) },
];

const out = []; let bad = 0;
const main = await runChecks(base);
if (main.failures.length) bad++;
out.push(`${main.failures.length ? "FAIL" : "PASS"}  the repository as it stands: ${main.passed} checks passed, ${main.failures.length} failed`);
for (const f of main.failures) out.push(`        FAILED: ${f}`);
let caught = 0, expectFail = 0;
for (const p of PLANTS) {
  const planted = p.make();
  const changed = planted.gate !== base.gate || PAGES.some((n) => planted.pages[n] !== base.pages[n]);
  if (p.expect === "fail" && !changed) { bad++; out.push(`FAIL  ${p.name}: the plant changed nothing, so it proves nothing (update the plant)`); continue; }
  const r = await runChecks(planted);
  if (p.expect === "pass") {
    const good = r.failures.length === 0; if (!good) bad++;
    out.push(`${good ? "PASS" : "FAIL"}  ${p.name}${good ? "" : ": " + r.failures.join("; ")}`);
  } else {
    expectFail++;
    const good = r.failures.length > 0; if (good) caught++; else bad++;
    out.push(`${good ? "PASS" : "FAIL"}  ${p.name} -> ${good ? "caught (" + r.failures.length + " check(s), e.g. " + r.failures[0].slice(0, 80) + ")" : "MISSED"}`);
  }
}
out.push(`planted defects caught: ${caught} of ${expectFail}`);
console.log(out.join("\n"));
console.log(`\nTOTAL: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
