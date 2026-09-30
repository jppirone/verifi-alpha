// Deterministic tests of the Socrata client's retry / rate-limit / pagination / timeout behavior using an injected fake fetch,
// so every failure mode is exercised exactly (real portals will not rate-limit us on demand).
//   node tools/registry/test-client.ts
import assert from "node:assert/strict";
import { SocrataClient } from "../../supabase/functions/_shared/registry/socrata.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function scripted(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request) => { calls.push(String(url)); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; if (r instanceof Error) throw r; return r.clone(); };
  return { impl: impl as typeof fetch, calls };
}
function client(responses: Array<Response | Error>, extra: Partial<ConstructorParameters<typeof SocrataClient>[0]> = {}) {
  const f = scripted(responses); const sleeps: number[] = [];
  const c = new SocrataClient({ domain: "data.example.gov", datasetId: "abcd-1234", fetchImpl: f.impl, sleepImpl: async (ms) => { sleeps.push(ms); }, ...extra });
  return { c, f, sleeps };
}

let n = 0; const ok = (name: string) => console.log(`  PASS  ${name}`) || n++;

{ // 429 with Retry-After: waits exactly what the server said, then succeeds
  const { c, f, sleeps } = client([json({}, 429, { "retry-after": "2" }), json({}, 429, { "retry-after": "1" }), json([{ a: 1 }])]);
  const r = await c.query({ where: "a=1" });
  assert.ok(r.ok && r.rows.length === 1 && r.attempts === 3); assert.deepEqual(sleeps, [2000, 1000]); assert.equal(f.calls.length, 3);
  assert.equal(c.stats.rateLimited, 2); ok("429 + Retry-After: honored (waited 2000ms then 1000ms), succeeded on attempt 3");
}
{ // 503 then 200, no Retry-After -> exponential backoff with jitter inside the expected window
  const { c, sleeps } = client([json({}, 503), json({}, 502), json([{ a: 1 }])]);
  const r = await c.query({}); assert.ok(r.ok && r.attempts === 3);
  assert.ok(sleeps[0] >= 200 && sleeps[0] <= 400, `first backoff ${sleeps[0]}`); assert.ok(sleeps[1] >= 400 && sleeps[1] <= 800, `second backoff ${sleeps[1]}`);
  ok(`5xx: retried with exponential backoff + jitter (waited ${sleeps.map((x) => Math.round(x)).join("ms, ")}ms)`);
}
{ // 429 forever -> labeled rate-limited after 5 attempts, NOT "not found" and not a generic failure
  const { c, f } = client([json({}, 429)]);
  const r = await c.query({}); assert.ok(!r.ok && r.error === "socrata_rate_limited" && r.attempts === 5 && f.calls.length === 5);
  ok("429 forever: gave up after 5 attempts with its own code socrata_rate_limited");
}
{ // a malformed query is not retried
  const { c, f } = client([json({ message: "bad soql" }, 400)]);
  const r = await c.query({}); assert.ok(!r.ok && r.error === "socrata_bad_query" && r.status === 400 && f.calls.length === 1);
  ok("400: NOT retried (1 call), reported as socrata_bad_query");
}
{ // network error then success
  const { c } = client([new Error("ECONNRESET"), json([{ a: 1 }])]);
  const r = await c.query({}); assert.ok(r.ok && r.attempts === 2); ok("network error: retried, succeeded on attempt 2");
}
{ // persistent network failure -> socrata_unavailable
  const { c } = client([new Error("ENOTFOUND")], { maxRetries: 2 });
  const r = await c.query({}); assert.ok(!r.ok && r.error === "socrata_unavailable" && r.attempts === 3); ok("network down: socrata_unavailable after 3 attempts");
}
{ // timeout: a fetch that only ever ends by abort
  const hang = (async (_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
  const sleeps: number[] = [];
  const c = new SocrataClient({ domain: "d", datasetId: "x", fetchImpl: hang, sleepImpl: async (m) => { sleeps.push(m); }, timeoutMs: 30, maxRetries: 1 });
  const t = Date.now(); const r = await c.query({});
  assert.ok(!r.ok && r.error === "socrata_unavailable" && r.attempts === 2 && Date.now() - t < 2000); ok("hung request: aborted by the per-attempt timeout (2 attempts), not stuck");
}
{ // app token is sent as X-App-Token only when configured
  let seen: Record<string, string> = {};
  const impl = (async (_u: unknown, init?: RequestInit) => { seen = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)); return json([]); }) as typeof fetch;
  await new SocrataClient({ domain: "d", datasetId: "x", fetchImpl: impl, appToken: "TOKEN123" }).query({});
  assert.equal(seen["X-App-Token"], "TOKEN123");
  await new SocrataClient({ domain: "d", datasetId: "x", fetchImpl: impl }).query({});
  assert.equal(seen["X-App-Token"], undefined); ok("auth: X-App-Token sent when configured, absent otherwise");
}
{ // pagination over a fake 2350-row dataset with page size 1000: 3 pages, stable offsets, no duplicates, stops on the short page
  const all = Array.from({ length: 2350 }, (_, i) => ({ id: i }));
  const offsets: number[] = [];
  const impl = (async (url: string) => { const u = new URL(url); const off = Number(u.searchParams.get("$offset") ?? 0); const lim = Number(u.searchParams.get("$limit")); offsets.push(off); assert.ok(u.searchParams.get("$order")); return json(all.slice(off, off + lim)); }) as typeof fetch;
  const c = new SocrataClient({ domain: "d", datasetId: "x", fetchImpl: impl });
  const got: number[] = []; for await (const page of c.paginate<{ id: number }>({ order: "id", pageSize: 1000 })) got.push(...page.map((x) => x.id));
  assert.equal(got.length, 2350); assert.equal(new Set(got).size, 2350); assert.deepEqual(offsets, [0, 1000, 2000]);
  ok("pagination: 2350 rows in 3 pages (offsets 0/1000/2000), no duplicates, stopped on the short page");
  const capped: number[] = []; for await (const page of c.paginate<{ id: number }>({ order: "id", pageSize: 1000, maxRows: 1500 })) capped.push(...page.map((x) => x.id));
  assert.equal(capped.length, 1500); ok("pagination: maxRows cap honored (1500 of 2350)");
  await assert.rejects(async () => { for await (const _ of c.paginate({ order: "", pageSize: 10 } as never)) void _; }, /requires an \$order/);
  ok("pagination: refuses to run without an $order (unstable page order)");
}
console.log(`\n${n} client tests passed`);
