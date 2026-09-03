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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
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
