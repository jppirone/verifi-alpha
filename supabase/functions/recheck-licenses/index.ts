// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

// Periodic re-check of already-Confirmed licenses (2026-09-21). See 20260921060000_license_recheck.sql for the whole story.
//
// Run hourly by pg_cron (over pg_net) with a shared secret (x-recheck-secret) that lives only in the database (internal_job_secrets); nothing else
// can call it. Each run takes the licenses that are due (due_license_rechecks: a registry pass that is still Confirmed and was never touched by
// staff, on a full-resume account that is not deactivated; most overdue first, at most MAX_PER_RUN), and for each one:
//   1. asks verify-license (action recheck_lookup: read-only, the same adapter and decide() as every other check) what the registry says now;
//   2. a clean pass  -> bookkeeping only (next check in 7 days, sooner right after the registry's own expiration date);
//      a lookup that failed / an incomplete license -> bookkeeping only (retry later with back-off), NEVER a downgrade;
//      anything else -> looks AGAIN after CONFIRM_WAIT_MS. Only if the second lookup is not a pass either AND gives the same reason is it
//      applied, through apply_license_downgrade, which can only move Confirmed -> Needs Reconciliation and re-checks under row locks that
//      nothing changed since (status, staff activity, number, state, name). Anything else about the two lookups (second one passes, or a
//      different problem) leaves the license Confirmed and tries again tomorrow: one odd registry response never downgrades anyone.
// Rate: MAX_PER_RUN licenses per run, LOOKUP_SPACING_MS apart, and the run stops taking new licenses after TIME_BUDGET_MS; three lookup failures
// in a row (registry down) end the run without touching anything. Each run is recorded in license_recheck_runs (ids and counts only).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const MAX_PER_RUN = 25;
const LOOKUP_SPACING_MS = 3000;
const CONFIRM_WAIT_MS = 20000;
const TIME_BUDGET_MS = 95000;
const MAX_CONSECUTIVE_FAILURES = 3;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function rpc(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: REST, body: JSON.stringify(args), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch (_e) { /* not json */ }
    return { ok: r.ok, data, text };
  } catch (e) { return { ok: false, data: null, text: String(e) }; }
}
async function lookup(candidateId: string, licenseId: string): Promise<any | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
      method: "POST", headers: REST, signal: AbortSignal.timeout(55000),
      body: JSON.stringify({ action: "recheck_lookup", candidate_id: candidateId, license_item_id: licenseId }),
    });
    return await r.json().catch(() => null);
  } catch (_e) { return null; }
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    const provided = req.headers.get("x-recheck-secret") || "";
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/internal_job_secrets?name=eq.recheck_licenses&select=value`, { headers: REST });
    const secret = sRes.ok ? ((await sRes.json())[0]?.value ?? "") : "";
    if (!provided || !secret || !safeEqual(provided, secret)) return json({ ok: false, error: "unauthorized" }, 401);

    const startedAt = new Date();
    const due = await rpc("due_license_rechecks", { p_limit: MAX_PER_RUN });
    if (!due.ok || !Array.isArray(due.data)) return json({ ok: false, error: "due_lookup_failed" }, 500);

    const detail: Array<{ license_item_id: string; result: string }> = [];
    let stillVerified = 0, downgraded = 0, errors = 0, skipped = 0, attempted = 0, consecutiveFailures = 0;
    let aborted: string | null = null;
    const dueRows = due.data as Array<{ license_item_id: string; candidate_id: string; total_due: number; overdue_days: number }>;
    const note = async (id: string, result: string) => { detail.push({ license_item_id: id, result }); };
    const book = (id: string, result: string) => rpc("record_license_recheck", { p_license: id, p_result: result });

    for (const d of dueRows) {
      if (Date.now() - startedAt.getTime() > TIME_BUDGET_MS) break;
      if (attempted > 0) await sleep(LOOKUP_SPACING_MS);
      attempted++;
      const id = d.license_item_id;
      try {
        const a = await lookup(d.candidate_id, id);
        if (!a || a.ok !== true) {
          errors++; consecutiveFailures++; await book(id, "error"); await note(id, "error");
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { aborted = "registry_unreachable"; break; }
          continue;
        }
        consecutiveFailures = 0;
        if (a.status === "not_eligible") { skipped++; await note(id, "not_eligible"); continue; }   // changed since the list was taken; nothing recorded
        if (a.status !== "checked") { skipped++; await book(id, "skipped"); await note(id, "skipped_" + String(a.why || "unknown")); continue; }
        if (a.outcome === "verified") { stillVerified++; await book(id, "still_verified"); await note(id, "still_verified"); continue; }

        // not a clean pass: look again before believing it
        await sleep(CONFIRM_WAIT_MS);
        const b = await lookup(d.candidate_id, id);
        if (!b || b.ok !== true || b.status !== "checked") { errors++; await book(id, "error"); await note(id, "unconfirmed_second_lookup_failed"); continue; }
        if (b.outcome === "verified") { stillVerified++; await book(id, "still_verified"); await note(id, "transient_adverse_then_verified"); continue; }
        if (b.outcome !== a.outcome || b.reason !== a.reason) { skipped++; await book(id, "unstable"); await note(id, "unstable_two_different_results"); continue; }

        const applied = await rpc("apply_license_downgrade", { p_license: id, p_expect: b.expect, p_decision: { outcome: b.outcome, reason: b.reason, detail: b.detail } });
        const result = applied.ok && applied.data ? String(applied.data.result || "unknown") : "apply_failed";
        if (result === "downgraded") { downgraded++; await note(id, "downgraded:" + String(applied.data.reason)); }
        else { skipped++; await book(id, "refused"); await note(id, "not_downgraded:" + (applied.data && applied.data.why ? String(applied.data.why) : result)); }
      } catch (e) {
        errors++; await book(id, "error"); await note(id, "exception");
      }
    }

    const oldest = dueRows.length ? Math.max(...dueRows.map((r) => Number(r.overdue_days) || 0)) : null;
    const summary = {
      started_at: startedAt.toISOString(), due_total: dueRows.length ? Number(dueRows[0].total_due) : 0, attempted, still_verified: stillVerified, downgraded, errors, skipped,
      oldest_overdue_days: oldest, aborted, detail,
    };
    await rpc("finish_license_recheck_run", { p_summary: summary });
    return json({ ok: true, ...summary, detail: undefined, results: detail });
  }),
};
