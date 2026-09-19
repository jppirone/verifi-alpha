// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { querySocrata, querySocrataFullText, soqlUpperEquals, type SocrataConfig } from "./socrata.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Colorado Secretary of State business-entity registry, via the state's own official Socrata
// (SODA) API — data.colorado.gov, dataset 4ykn-tg5h ("Business Entities in Colorado", ~3.06M
// rows, updated daily, Public Domain). Unlike Sunbiz, this is a real structured JSON API with no
// Cloudflare-style bot wall: every query made while building and testing this — well over a dozen,
// unauthenticated — returned a clean 200 with real JSON. Field names below were pulled from the
// dataset's own metadata (GET https://data.colorado.gov/api/views/4ykn-tg5h.json) and confirmed
// against real query results before writing this, not assumed — note in particular that the
// state's own field name for jurisdiction of formation is actually misspelled
// "jurisdictonofformation" (missing the second i), which is exactly the kind of thing this
// discipline exists to catch instead of silently 400ing on a guessed field name.
//
// Matching, verified against real entities: an upper(entityname)= exact query for "CROCS, INC."
// correctly returns TWO real, distinct rows — the original Colorado-domiciled entity (status
// "Merged", jurisdiction CO) and the current active Delaware entity foreign-qualified in Colorado
// (status "Good Standing", jurisdiction DE) — a genuine real-world ambiguity (same exact legal
// name, two different registry records), not a hypothetical. Per that finding, this returns every
// matching row rather than picking one "best" record — a fabricated name (tested:
// "ZZZ Nonexistent Entity Qwerty12345, Inc.") correctly returns zero rows and found:false, with no
// false-positive neighbor-matching (unlike Sunbiz's alphabetical-browse behavior — Socrata's
// $where is a real filter, not a "start browsing here" list).

const CONFIG: SocrataConfig = { domain: "data.colorado.gov", datasetId: "4ykn-tg5h" };

interface CoEntityRow {
  entityid?: string;
  entityname?: string;
  entitystatus?: string;
  entitytype?: string;
  jurisdictonofformation?: string; // sic — the dataset's own (misspelled) field name
  principalcity?: string;
  principalstate?: string;
}

function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^THE\s+/, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (staff/internal endpoint auth pass, 2026-09-19).
// This function used to have no caller check beyond the platform's own key check, which the PUBLIC anon key (embedded in
// candidate.html and staff.html) passes: anyone could call it. It now requires one of:
//   * the service-role key as the bearer token (what our own functions send when they call each other; exact match,
//     constant-time compare), where the function allows internal callers; or
//   * a live STAFF session: the staff_session_token staff.html already holds from staff-confirm-login, checked on every call
//     against staff_sessions (hashed, unrevoked, unexpired) and resolved to a staff_users row. Identity is never taken from
//     the request body.
// Anything else is the same 401 whether the token was missing, wrong, expired or revoked.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type AuthCaller = { kind: "service" } | { kind: "staff"; id: string; email: string; name: string; role: string };
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function authSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function authenticateStaffOrService(req: Request, body: any, allow: { staff: boolean; service: boolean }): Promise<AuthCaller | null> {
  if (allow.service) {
    const h = req.headers.get("authorization") || "";
    const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (t && AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY)) return { kind: "service" };
  }
  if (allow.staff) {
    const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
    if (tok.length >= 20 && tok.length <= 200) {
      const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
      const sRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: rest });
      const sess = sRes.ok ? (await sRes.json())[0] : null;
      if (sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now()) {
        const uRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`, { headers: rest });
        const u = uRes.ok ? (await uRes.json())[0] : null;
        if (u) return { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role };
      }
    }
  }
  return null;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    let authBody: any = {};
    try { authBody = await req.clone().json(); } catch (_e) { authBody = {}; }
    const caller = await authenticateStaffOrService(req, authBody, { staff: true, service: true });
    if (!caller) return UNAUTHORIZED();
    try {
      const { entity_name } = await req.json();
      if (!entity_name || typeof entity_name !== "string" || !entity_name.trim()) {
        return new Response(JSON.stringify({ ok: false, error: "entity_name is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const searchTerm = entity_name.trim();
      const searchNorm = normalizeName(searchTerm);

      const exactResult = await querySocrata<CoEntityRow>(CONFIG, soqlUpperEquals("entityname", searchTerm), 20);
      if (!exactResult.ok) {
        return new Response(JSON.stringify({ ok: false, error: exactResult.error, status: exactResult.status, detail: exactResult.detail }), {
          status: exactResult.error === "socrata_rate_limited" ? 429 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let rows = exactResult.rows;
      let rowsAreExactByConstruction = true;

      if (rows.length === 0) {
        // No exact upper()= hit — fall back to Socrata's full-text search so a real near-miss
        // (punctuation, a dropped "The", a typo'd suffix) still surfaces instead of a flat
        // not-found. Every row from this path is a fuzzy candidate, never assumed exact.
        const fuzzyResult = await querySocrataFullText<CoEntityRow>(CONFIG, searchTerm, 10);
        if (!fuzzyResult.ok) {
          return new Response(JSON.stringify({ ok: false, error: fuzzyResult.error, status: fuzzyResult.status, detail: fuzzyResult.detail }), {
            status: fuzzyResult.error === "socrata_rate_limited" ? 429 : 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        rows = fuzzyResult.rows;
        rowsAreExactByConstruction = false;
      }

      if (rows.length === 0) {
        return new Response(JSON.stringify({ ok: true, found: false, matches: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Sanity-check the shape actually has the fields this relies on — if Colorado renames or
      // drops entityname, this reports unexpected_response_shape instead of silently mismatching.
      if (rows.some((r) => typeof r.entityname !== "string")) {
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "a row was missing the expected entityname field" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const matches = rows.map((row) => ({
        name: row.entityname || "",
        exactMatch: rowsAreExactByConstruction ? true : normalizeName(row.entityname || "") === searchNorm,
        entityId: row.entityid || null,
        status: row.entitystatus || null,
        entityType: row.entitytype || null,
        jurisdiction: row.jurisdictonofformation || null,
        principalCity: row.principalcity || null,
        principalState: row.principalstate || null,
      }));

      return new Response(JSON.stringify({
        ok: true,
        found: true,
        matches, // every real matching row, each flagged exactMatch — multiple real candidates (see
                 // the CROCS, INC. case above) are surfaced, never silently resolved to one
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
