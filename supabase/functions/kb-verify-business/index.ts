import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { socrataBusinessSources } from "../_shared/registry/business-sources.ts";
import { authenticateRegistryCaller, isRegistryAdmin } from "../_shared/registry/auth.ts";
import { KB_ENABLED_SOURCES, kbNameKey, verifyBusiness } from "../_shared/kb/kb.ts";
import { kbStats, makePgKbStore } from "../_shared/kb/pg-store.ts";

// Verification Knowledge Base, Tier 0/1 (Decision 39, 2026-10-01): "does this employer exist as a registered business in this state?"
//
// POST {name, state, force_refresh?, staff_session_token?}  -> {status, manual_verification_required, message, from_cache, cache_result,
//        entity?, candidates?, registry:{queried, calls, ms}, log_id}
//   status: verified | not_found | ambiguous | conflict | inconclusive | no_automated_source   (anything but verified needs a human)
// POST {action:"stats", since?}  (admin)  -> the hit / miss / stale numbers from kb_lookup_log
//
// The knowledge base is checked first (exact match on state + normalized name); a fresh hit never touches the registry. A miss or a stale
// entry asks the live registry (Colorado SOS, data.colorado.gov/4ykn-tg5h, the only registry enabled so far), and every successful
// verification is written back so the next candidate who lists the same employer is a cache hit. Every lookup is logged either way.
// Auth: service-role bearer or a live staff session (any role: registry data is public record and carries no candidate data).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_TOKEN = Deno.env.get("SOCRATA_APP_TOKEN") || undefined;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const pg = { baseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY };

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const caller = await authenticateRegistryCaller(req, body, SUPABASE_URL, SERVICE_KEY);
    if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

    try {
      if (body.action === "stats") {
        if (!isRegistryAdmin(caller)) return json({ ok: false, error: "forbidden" }, 403);
        return json({ ok: true, stats: await kbStats(pg, typeof body.since === "string" ? body.since : undefined) });
      }
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 300) : "";
      const state = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
      if (!/^[A-Z]{2}$/.test(state)) return json({ ok: false, error: "state_required", message: "Pass the employer's two-letter state." }, 400);
      if (kbNameKey(name).length < 2) return json({ ok: false, error: "name_required", message: "Pass the employer name." }, 400);

      const sources = socrataBusinessSources(APP_TOKEN);
      const result = await verifyBusiness({
        store: makePgKbStore(pg),
        registryFor: (st) => { const id = KB_ENABLED_SOURCES[st]; return id ? sources.find((s) => s.id === id) ?? null : null; },
      }, { name, state, caller: caller.kind === "staff" ? caller.email : "service", force_refresh: body.force_refresh === true });
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: "kb_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  }),
};
