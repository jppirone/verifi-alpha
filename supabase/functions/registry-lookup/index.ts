import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { parquetReadObjects } from "npm:hyparquet@1.31.2";
import { compressors } from "npm:hyparquet-compressors@1.1.2";
import { socrataBusinessSources } from "../_shared/registry/business-sources.ts";
import { socrataLicenseSources } from "../_shared/registry/license-sources.ts";
import { dbSources, loadedRuns } from "../_shared/registry/db-registry.ts";
import { lookupBusiness, lookupLicense } from "../_shared/registry/lookup.ts";
import { summarizeVerification } from "../_shared/registry/verification.ts";
import { authenticateRegistryCaller } from "../_shared/registry/auth.ts";

// State business-registry + professional-license lookup (Stage 1, 2026-09-30; storage-backed bulk sources + manual-verification block 2026-10-01).
//
// One request shape, one response shape, every source. Body (JSON):
//   { kind: "business" | "license", staff_session_token?,
//     name?, entity_id?                                        (business)
//     name?, first_name?, last_name?, business_name?, license_number?, license_type?   (license; license_type narrows by licence-type text,
//        case-insensitive contains, applied BEFORE the 50-result cap -- use it to narrow a capped common-name search)
//     states: ["CO", ...]  (REQUIRED unless all_states: true -- see the egress rule below), sources?: ["co-sos", ...], limit?, include_people? }
// Response: { ok, kind, hits: [{source_id, match_type, record}], reports: [per-source status], not_loaded: [...], verification: {...} }.
// `verification` is the staff-facing answer: status + message saying whether the record must be checked by hand. An empty result is
// NEVER returned silently: no match, a failed source, and a state with no automated source each say so explicitly.
//
// Where the data comes from: Socrata sources are queried live; California DCA and Michigan LARA are read on demand from sharded Parquet
// in the private `registry-data` storage bucket (nothing is persisted or cached back); Florida is not loaded yet.
// Auth: service-role bearer or a live staff session (any role: registry data is public record and carries no candidate data).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_TOKEN = Deno.env.get("SOCRATA_APP_TOKEN") || undefined; // optional: raises Socrata's rate limit; works without it
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const strArr = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 30) as string[] : undefined;
const str = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const readParquet = (file: ArrayBuffer) => parquetReadObjects({ file, compressors }) as Promise<Array<Record<string, unknown>>>;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const caller = await authenticateRegistryCaller(req, body, SUPABASE_URL, SERVICE_KEY);
    if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

    const kind = body.kind;
    if (kind !== "business" && kind !== "license") return json({ ok: false, error: "kind_must_be_business_or_license" }, 400);
    const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
    const db = { baseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY };
    const runs = await loadedRuns(db);
    const storageLoaded = new Set(runs.filter((r) => r.note === "storage").map((r) => r.source_id));
    const dbs = dbSources(db, new Set(runs.map((r) => r.source_id)), { baseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, readParquet }, storageLoaded);
    const common = { states: strArr(body.states), sources: strArr(body.sources), limit };
    // EGRESS RULE (2026-10-01): every lookup is scoped by the candidate's stated state(s). A lookup with no state used to fan out to every
    // source (reading a California shard AND a Michigan shard AND every live registry); that is refused unless the caller explicitly opts in
    // with all_states: true (a deliberate staff cross-state search), so cross-state reads never happen by default.
    if ((!common.states || common.states.length === 0) && body.all_states !== true) {
      return json({ ok: false, error: "states_required", message: "Pass the candidate's state(s) as states: [\"CO\", ...]. A lookup with no state is refused so it never reads every state's data by default; set all_states: true only for a deliberate cross-state search." }, 400);
    }
    try {
      if (kind === "business") {
        const name = str(body.name), entity_id = str(body.entity_id, 80);
        if (!name && !entity_id) return json({ ok: false, error: "name_or_entity_id_required" }, 400);
        const all = [...socrataBusinessSources(APP_TOKEN), ...dbs.business];
        const r = await lookupBusiness(all, { ...common, name, entity_id, include_people: body.include_people === true });
        const notLoaded = dbs.notLoaded.filter((n) => n.kind === "business");
        const verification = summarizeVerification({ hitCount: r.hits.length, reports: r.reports, notLoaded, requestedStates: common.states, coveredStates: all.map((s) => s.state) });
        return json({ ok: true, kind, ...r, not_loaded: notLoaded, loaded: runs.filter((x) => x.kind === "business"), verification });
      }
      const q = { name: str(body.name), first_name: str(body.first_name, 80), last_name: str(body.last_name, 80), business_name: str(body.business_name), license_number: str(body.license_number, 80), license_type: str(body.license_type, 80) };
      if (!q.name && !q.business_name && !(q.first_name && q.last_name) && !q.license_number) return json({ ok: false, error: "name_or_license_number_required" }, 400);
      const all = [...socrataLicenseSources(APP_TOKEN), ...dbs.license];
      const r = await lookupLicense(all, { ...common, ...q });
      const notLoaded = dbs.notLoaded.filter((n) => n.kind === "license");
      const verification = summarizeVerification({ hitCount: r.hits.length, reports: r.reports, notLoaded, requestedStates: common.states, coveredStates: all.map((s) => s.state) });
      return json({ ok: true, kind, ...r, not_loaded: notLoaded, loaded: runs.filter((x) => x.kind === "license"), verification });
    } catch (e) {
      return json({ ok: false, error: "lookup_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  }),
};
