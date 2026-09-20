// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "npm:@supabase/supabase-js@2";

// Deletes resume files from Storage (2026-09-20). See 20260920000000_resume_storage_purge.sql for the full story: the cleanup job
// deleted database rows and queued the file paths, and nothing ever removed the files.
//
// Two modes, both behind one shared secret (x-purge-secret) that lives only in the database (internal_job_secrets):
//   * "queue" (the cron job, every 15 minutes): remove every file in resume_storage_purge_queue that is still pending. Before removing a
//     path it re-checks that no resume_documents row now points at it (a row that came back is never deleted from under itself; the queue
//     entry is dropped instead). Paths that are not a plain storage path are skipped, never passed on.
//   * "reconcile": files nothing references (list_orphan_resume_objects). dry_run defaults to TRUE and only reports. A real run needs an
//     explicit "paths" list (never "everything") and deletes only those paths that are STILL orphans according to the database at that
//     moment (older than min_age_hours, standard layout, owner folder not a live candidate/verification/document owner); every other
//     requested path is reported as skipped and left alone.
//   * "sweep" (a second cron job, every 15 minutes; 2026-09-20): the standing safety net for STRAY files, e.g. upload-resume stored the file
//     and then its resume_documents insert failed, or only one of its two uploads (original / sanitized render) succeeded. Such a file has no
//     row, so the queue never learns about it. The sweep deletes a file only when ALL of these hold: it is in the standard
//     <owner>/<document>/(original.<ext>|sanitized.jpg) layout (anything else is left alone and only counted); no resume_documents row names
//     its path or is its document folder (checked again per file immediately before deleting); and it is older than min_age_hours (default 24,
//     never below 1) so an upload still in flight is never touched. Unlike "reconcile" it does NOT require the owner folder to be dead: a
//     stray from a failed upload sits in a LIVE signup's folder, and that signup row is never deleted, so the strict rule would protect it
//     forever. That is safe here because a file with no document row cannot be reached by anything in the app. Every deletion is recorded in
//     resume_storage_purge_queue as an already-purged audit row. dry_run:true only reports. At most 500 files per run.
// Only the resume-documents bucket is ever touched.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };
const MAX_PER_RUN = 500;
const BATCH = 100;
const SAFE_PATH = /^[A-Za-z0-9._\/-]{1,300}$/;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function isReferenced(path: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/resume_documents?or=(original_storage_path.eq."${path}",sanitized_render_path.eq."${path}")&select=id&limit=1`, { headers: REST });
  if (!r.ok) return true; // if we cannot tell, treat it as referenced: never delete on doubt
  return ((await r.json()) as unknown[]).length > 0;
}

// Sweep's per-file re-check: a row names the path, or is the document folder the path sits in. Any doubt (a failed lookup) counts as referenced.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function stillReferenced(path: string): Promise<boolean> {
  const docId = path.split("/")[1] ?? "";
  if (!UUID_RE.test(docId)) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/resume_documents?or=(original_storage_path.eq."${path}",sanitized_render_path.eq."${path}",id.eq.${docId})&select=id&limit=1`, { headers: REST });
  if (!r.ok) return true;
  return ((await r.json()) as unknown[]).length > 0;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    const provided = req.headers.get("x-purge-secret") || "";
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/internal_job_secrets?name=eq.purge_resume_storage&select=value`, { headers: REST });
    const secret = sRes.ok ? ((await sRes.json())[0]?.value ?? "") : "";
    if (!provided || !secret || !safeEqual(provided, secret)) return json({ ok: false, error: "unauthorized" }, 401);

    let body: any = {};
    try { body = await req.json(); } catch (_e) { body = {}; }
    const storage = createClient(SUPABASE_URL, SERVICE_KEY).storage.from(BUCKET);

    try {
      if (body.mode === "sweep") {
        // ---- sweep mode (see the header)
        const dryRun = body.dry_run === true;
        const minAgeHours = Math.min(Math.max(Number(body.min_age_hours ?? 24) || 24, 1), 24 * 365);
        const oRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_orphan_resume_objects`, {
          method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ p_min_age: `${minAgeHours} hours`, p_strict: false }),
        });
        if (!oRes.ok) return json({ ok: false, error: "orphan_listing_failed", detail: (await oRes.text()).slice(0, 200) }, 500);
        const found = (await oRes.json()) as { name: string; created_at: string; size: number | null; standard_layout: boolean }[];
        const candidates = found.filter((o) => o.standard_layout && SAFE_PATH.test(o.name));
        const leftNonstandard = found.length - candidates.length;
        const batchToConsider = candidates.slice(0, MAX_PER_RUN);
        const toDelete: string[] = [];
        let skippedReferenced = 0;
        for (const o of batchToConsider) {
          if (await stillReferenced(o.name)) skippedReferenced++; else toDelete.push(o.name);
        }
        let deleted = 0;
        if (!dryRun) {
          for (let i = 0; i < toDelete.length; i += BATCH) {
            const batch = toDelete.slice(i, i + BATCH);
            const { error } = await storage.remove(batch);
            if (error) return json({ ok: false, error: "storage_remove_failed", detail: error.message, deleted }, 502);
            deleted += batch.length;
            // audit trail: an already-purged queue row per deleted file (a pending row for the same path is left for the queue run to close out)
            await fetch(`${SUPABASE_URL}/rest/v1/resume_storage_purge_queue?on_conflict=bucket,path`, {
              method: "POST", headers: { ...REST, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates,return=minimal" },
              body: JSON.stringify(batch.map((path) => ({ path, purged_at: new Date().toISOString() }))),
            });
          }
        }
        return json({
          ok: true, mode: "sweep", dry_run: dryRun, min_age_hours: minAgeHours, unreferenced_found: found.length, stray_candidates: candidates.length,
          considered: batchToConsider.length, skipped_referenced_at_recheck: skippedReferenced, left_nonstandard_layout: leftNonstandard,
          deleted, would_delete: dryRun ? toDelete.length : undefined, deleted_names: (dryRun ? toDelete : toDelete.slice(0, deleted)).slice(0, 20),
        });
      }
      if (body.mode !== "reconcile") {
        // ---- queue mode
        const qRes = await fetch(`${SUPABASE_URL}/rest/v1/resume_storage_purge_queue?purged_at=is.null&bucket=eq.${BUCKET}&select=id,path&order=queued_at.asc&limit=${MAX_PER_RUN}`, { headers: REST });
        if (!qRes.ok) return json({ ok: false, error: "queue_read_failed" }, 500);
        const rows = (await qRes.json()) as { id: string; path: string }[];
        const toRemove: { id: string; path: string }[] = [];
        let skippedReferenced = 0, skippedUnsafe = 0;
        for (const row of rows) {
          if (!SAFE_PATH.test(row.path)) { skippedUnsafe++; continue; }
          if (await isReferenced(row.path)) {
            skippedReferenced++;
            await fetch(`${SUPABASE_URL}/rest/v1/resume_storage_purge_queue?id=eq.${row.id}`, { method: "DELETE", headers: REST }); // a row exists again: not a purge any more
            continue;
          }
          toRemove.push(row);
        }
        let removed = 0;
        for (let i = 0; i < toRemove.length; i += BATCH) {
          const batch = toRemove.slice(i, i + BATCH);
          const { error } = await storage.remove(batch.map((b) => b.path));
          if (error) return json({ ok: false, error: "storage_remove_failed", detail: error.message, removed }, 502);
          // A path that was already gone is fine: the goal is that the object does not exist.
          const ids = batch.map((b) => b.id).join(",");
          await fetch(`${SUPABASE_URL}/rest/v1/resume_storage_purge_queue?id=in.(${ids})`, {
            method: "PATCH", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ purged_at: new Date().toISOString() }),
          });
          removed += batch.length;
        }
        // housekeeping: purged queue rows are only an audit trail
        await fetch(`${SUPABASE_URL}/rest/v1/resume_storage_purge_queue?purged_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())}`, { method: "DELETE", headers: REST });
        return json({ ok: true, mode: "queue", pending_seen: rows.length, removed, skipped_referenced: skippedReferenced, skipped_unsafe_path: skippedUnsafe });
      }

      // ---- reconcile mode
      const dryRun = body.dry_run !== false;
      const minAgeHours = Math.min(Math.max(Number(body.min_age_hours ?? 24) || 0, 0), 24 * 365);
      const oRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_orphan_resume_objects`, {
        method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ p_min_age: `${minAgeHours} hours`, p_strict: true }),
      });
      if (!oRes.ok) return json({ ok: false, error: "orphan_listing_failed", detail: (await oRes.text()).slice(0, 200) }, 500);
      const orphans = (await oRes.json()) as { name: string; created_at: string; size: number | null }[];
      if (dryRun) {
        return json({
          ok: true, mode: "reconcile", dry_run: true, min_age_hours: minAgeHours, orphan_count: orphans.length,
          total_bytes: orphans.reduce((s, o) => s + (o.size ?? 0), 0),
          oldest: orphans.reduce((m, o) => (m === null || o.created_at < m ? o.created_at : m), null as string | null),
          newest: orphans.reduce((m, o) => (m === null || o.created_at > m ? o.created_at : m), null as string | null),
          ...(body.include_names ? { names: orphans.map((o) => o.name) } : {}),
        });
      }
      const want: unknown = body.paths;
      if (!Array.isArray(want) || want.length === 0 || want.some((p) => typeof p !== "string")) return json({ ok: false, error: "paths_required", detail: "a real reconcile run needs an explicit non-empty list of paths" }, 400);
      if (want.length > MAX_PER_RUN) return json({ ok: false, error: "too_many_paths", max: MAX_PER_RUN }, 400);
      const orphanSet = new Set(orphans.map((o) => o.name));
      const toDelete = (want as string[]).filter((p) => orphanSet.has(p) && SAFE_PATH.test(p));
      const skipped = (want as string[]).filter((p) => !orphanSet.has(p) || !SAFE_PATH.test(p));
      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += BATCH) {
        const batch = toDelete.slice(i, i + BATCH);
        const { error } = await storage.remove(batch);
        if (error) return json({ ok: false, error: "storage_remove_failed", detail: error.message, deleted, skipped }, 502);
        deleted += batch.length;
      }
      return json({ ok: true, mode: "reconcile", dry_run: false, requested: want.length, deleted, skipped_count: skipped.length, skipped: skipped.slice(0, 50) });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e).slice(0, 200) }, 500);
    }
  }),
};
