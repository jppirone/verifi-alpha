import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { socrataBusinessSources } from "../_shared/registry/business-sources.ts";
import { socrataLicenseSources } from "../_shared/registry/license-sources.ts";
import { dbSources, loadedRuns } from "../_shared/registry/db-registry.ts";
import { lookupBusiness, lookupLicense } from "../_shared/registry/lookup.ts";
import { authenticateRegistryCaller } from "../_shared/registry/auth.ts";

// State business-registry + professional-license lookup (Stage 1, 2026-09-30).
//
// One request shape, one response shape, every source. Body (JSON):
//   { kind: "business" | "license", staff_session_token?,
//     name?, entity_id?                                        (business)
//     name?, first_name?, last_name?, business_name?, license_number?   (license)
//     states?: ["CO", ...], sources?: ["co-sos", ...], limit?, include_people? }
// Response: { ok, kind, hits: [{source_id, match_type, record}], reports: [per-source status], not_loaded: [...] }.
// A source that failed is reported in `reports` with its error -- it is never silently treated as "no match".
//
// Auth: service-role bearer or a live staff session (any role: registry data is public record and carries no candidate data).
// Socrata sources are queried live; file-based sources (FL Sunbiz, CA DCA, MI, DE, FL DOH) are read from our tables once loaded.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_TOKEN = Deno.env.get("SOCRATA_APP_TOKEN") || undefined; // optional: raises Socrata's rate limit; works without it
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const strArr = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 30) as string[] : undefined;
const str = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

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
    const dbs = dbSources(db, new Set(runs.map((r) => r.source_id)));
    const common = { states: strArr(body.states), sources: strArr(body.sources), limit };
    try {
      if (kind === "business") {
        const name = str(body.name), entity_id = str(body.entity_id, 80);
        if (!name && !entity_id) return json({ ok: false, error: "name_or_entity_id_required" }, 400);
        const r = await lookupBusiness([...socrataBusinessSources(APP_TOKEN), ...dbs.business], { ...common, name, entity_id, include_people: body.include_people === true });
        return json({ ok: true, kind, ...r, not_loaded: dbs.notLoaded.filter((n) => n.kind === "business"), loaded: runs.filter((x) => x.kind === "business") });
      }
      const q = { name: str(body.name), first_name: str(body.first_name, 80), last_name: str(body.last_name, 80), business_name: str(body.business_name), license_number: str(body.license_number, 80) };
      if (!q.name && !q.business_name && !(q.first_name && q.last_name) && !q.license_number) return json({ ok: false, error: "name_or_license_number_required" }, 400);
      const r = await lookupLicense([...socrataLicenseSources(APP_TOKEN), ...dbs.license], { ...common, ...q });
      return json({ ok: true, kind, ...r, not_loaded: dbs.notLoaded.filter((n) => n.kind === "license"), loaded: runs.filter((x) => x.kind === "license") });
    } catch (e) {
      return json({ ok: false, error: "lookup_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  }),
};
