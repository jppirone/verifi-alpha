import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { authenticateRegistryCaller, isRegistryAdmin } from "../_shared/registry/auth.ts";
import { DB_BUSINESS_META, DB_LICENSE_META } from "../_shared/registry/db-registry.ts";
import { businessProblems, licenseProblems } from "../_shared/registry/schema.ts";
import { nameKey } from "../_shared/registry/normalize.ts";

// Bulk-load endpoint for the FILE-BASED registry / license sources (FL Sunbiz, CA DCA, MI, DE, FL DOH).
// Files are downloaded and PARSED outside the function (tools/registry/ingest.ts, or a scheduled job) into the common
// normalized shape; this endpoint validates and stores them. Three actions, admin staff session or service role only:
//   {action:"begin",  source_id, kind, file_name?, file_sha256?, note?}              -> {run_id}
//   {action:"batch",  run_id, rows:[...]}  (<= 1000 rows)                            -> {upserted, rejected}
//     license rows:  {record_key, last_name?, first_name?, record: LicenseRecord}
//     business rows: {record: BusinessEntity}   (entity_id is the key)
//   {action:"finish", run_id, prune?: true}                                          -> marks the run complete; prune:true
//     deletes rows of this source that were NOT touched by this run (a full-file refresh dropping people who left the file).
// Every row is validated against the same schema the live adapters are tested with; an invalid row is counted as rejected and
// never stored. Nothing is written for a source id that is not registered.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const MAX_BATCH = 1000;

async function pg(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } });
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: Record<string, any> = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const caller = await authenticateRegistryCaller(req, body, SUPABASE_URL, SERVICE_KEY);
    if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
    if (!isRegistryAdmin(caller)) return json({ ok: false, error: "forbidden" }, 403);

    try {
      if (body.action === "begin") {
        const kind = body.kind === "business" ? "business" : body.kind === "license" ? "license" : null;
        const metas = kind === "business" ? DB_BUSINESS_META : DB_LICENSE_META;
        if (!kind || !metas.some((m) => m.id === body.source_id)) return json({ ok: false, error: "unknown_source_or_kind" }, 400);
        const r = await pg("registry_ingest_runs", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            source_id: body.source_id, kind, file_name: String(body.file_name ?? "").slice(0, 300) || null,
            file_sha256: String(body.file_sha256 ?? "").slice(0, 80) || null, note: String(body.note ?? "").slice(0, 500) || null,
          }),
        });
        if (!r.ok) return json({ ok: false, error: "begin_failed", detail: (await r.text()).slice(0, 300) }, 500);
        return json({ ok: true, run_id: (await r.json())[0].id });
      }

      const runId = typeof body.run_id === "string" && /^[0-9a-f-]{36}$/.test(body.run_id) ? body.run_id : null;
      if (!runId) return json({ ok: false, error: "run_id_required" }, 400);
      const rr = await pg(`registry_ingest_runs?id=eq.${runId}&select=id,source_id,kind,status,started_at,rows_upserted,rows_rejected`);
      const run = rr.ok ? (await rr.json())[0] : null;
      if (!run) return json({ ok: false, error: "run_not_found" }, 404);
      if (run.status !== "running") return json({ ok: false, error: "run_not_running" }, 409);

      if (body.action === "batch") {
        const rows = Array.isArray(body.rows) ? body.rows : null;
        if (!rows || rows.length === 0 || rows.length > MAX_BATCH) return json({ ok: false, error: `rows_must_be_1_to_${MAX_BATCH}` }, 400);
        const out: Array<Record<string, unknown>> = []; let rejected = 0; const samples: string[] = [];
        const now = new Date().toISOString();
        for (const row of rows) {
          const rec = row?.record;
          if (run.kind === "license") {
            const p = licenseProblems(rec);
            const key = typeof row?.record_key === "string" ? row.record_key.slice(0, 200) : "";
            if (p.length || !key) { rejected++; if (samples.length < 3) samples.push(p[0] ?? "no record_key"); continue; }
            out.push({
              source_id: run.source_id, record_key: key, license_holder_name: rec.license_holder_name, holder_kind: rec.holder_kind, name_key: nameKey(rec.license_holder_name),
              last_key: row.last_name ? nameKey(row.last_name) : null, first_key: row.first_name ? nameKey(row.first_name) : null, license_number: rec.license_number,
              license_type: rec.license_type, status: rec.status, status_raw: rec.status_raw, issue_date: rec.issue_date, expiration_date: rec.expiration_date,
              state: rec.state, board_agency: rec.board_agency, source: rec.source, details: rec.details ?? {}, ingested_at: now,
            });
          } else {
            const p = businessProblems(rec);
            if (p.length) { rejected++; if (samples.length < 3) samples.push(p[0]); continue; }
            out.push({
              source_id: run.source_id, entity_id: rec.entity_id, entity_name: rec.entity_name, name_key: nameKey(rec.entity_name), status: rec.status, status_raw: rec.status_raw,
              registration_date: rec.registration_date, entity_type: rec.entity_type, state: rec.state, source_dataset: rec.source_dataset, details: rec.details ?? {}, ingested_at: now,
            });
          }
        }
        // De-duplicate on the primary key inside the batch (an upsert batch may not touch one key twice); last one wins.
        const pk = run.kind === "license" ? "record_key" : "entity_id";
        const uniq = [...new Map(out.map((o) => [o[pk], o])).values()];
        if (uniq.length) {
          const table = run.kind === "license" ? "license_records" : "registry_entities";
          const r = await pg(`${table}?on_conflict=source_id,${pk}`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(uniq) });
          if (!r.ok) return json({ ok: false, error: "upsert_failed", detail: (await r.text()).slice(0, 400) }, 500);
        }
        await pg(`registry_ingest_runs?id=eq.${runId}`, { method: "PATCH", body: JSON.stringify({ rows_upserted: run.rows_upserted + uniq.length, rows_rejected: run.rows_rejected + rejected }) });
        return json({ ok: true, upserted: uniq.length, duplicates_in_batch: out.length - uniq.length, rejected, rejected_samples: samples });
      }

      if (body.action === "finish") {
        let pruned = 0;
        if (body.prune === true) {
          const table = run.kind === "license" ? "license_records" : "registry_entities";
          const r = await pg(`${table}?source_id=eq.${encodeURIComponent(run.source_id)}&ingested_at=lt.${encodeURIComponent(run.started_at)}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
          if (!r.ok) return json({ ok: false, error: "prune_failed", detail: (await r.text()).slice(0, 300) }, 500);
          pruned = (await r.json()).length;
        }
        await pg(`registry_ingest_runs?id=eq.${runId}`, { method: "PATCH", body: JSON.stringify({ status: "complete", finished_at: new Date().toISOString(), rows_pruned: pruned }) });
        return json({ ok: true, run_id: runId, rows_upserted: run.rows_upserted, rows_rejected: run.rows_rejected, rows_pruned: pruned });
      }
      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (e) {
      return json({ ok: false, error: "ingest_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  }),
};
