// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { querySocrata, soqlUpperEquals, type SocrataConfig } from "./socrata.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Colorado DORA (Department of Regulatory Agencies) professional/occupational license data, via
// the state's own official Socrata (SODA) API — data.colorado.gov, dataset 7s5z-vewr
// ("Professional and Occupational Licenses in Colorado", updated nightly). Same platform, same
// no-bot-wall situation as verify-co-sos-entity (see socrata.ts) — every query made while building
// this succeeded with a clean 200. Field names below were pulled from the dataset's own metadata
// (GET https://data.colorado.gov/api/views/7s5z-vewr.json) and confirmed against real rows, not
// assumed. Two real findings from that testing, both load-bearing:
//
// 1. Primary search is by name, per design (candidates realistically have a name, not a license
//    number, on hand — same correction already made for Florida DBPR). Both an individual path
//    (lastname/firstname) and a business path (entityname — DORA licenses businesses directly for
//    things like salons, out-of-state pharmacies, and registered massage establishments, confirmed
//    real via a live query) are supported, since the dataset genuinely has both kinds of licensee.
// 2. licensenumber in this dataset is NOT globally unique the way DBPR's is in Florida — it's
//    apparently scoped per license type/board. Verified live: querying licensenumber='23840'
//    alone returns AT LEAST 10 completely unrelated real people across 10 different boards (a
//    physician assistant in Michigan, a nurse in Colorado Springs, a CPA in Delaware, an architect
//    in Aurora, and more — same number, different person, different board, every time). Treating a
//    bare license number as a precise identifier here would be actively wrong, not just imprecise.
//    So license_number is only ever applied as an additional AND filter alongside a name and/or
//    license_type — never as a standalone lookup that implies precision. If no name or entity is
//    given, a license-number-only search still runs, but every result gets exactMatch:null (there
//    is nothing to compare the number against) and staff should expect it to often be ambiguous.

const CONFIG: SocrataConfig = { domain: "data.colorado.gov", datasetId: "7s5z-vewr" };

interface CoLicenseRow {
  lastname?: string;
  firstname?: string;
  middlename?: string;
  entityname?: string;
  city?: string;
  state?: string;
  licensetype?: string;
  subcategory?: string;
  licensenumber?: string;
  licensestatusdescription?: string;
  licenseexpirationdate?: string;
  linktoverifylicense?: { url?: string };
}

function normalizePersonName(last: string, first: string): string {
  const flat = (s: string) => (s || "").toUpperCase().replace(/[-.]/g, " ").replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return (flat(last) + " " + flat(first)).trim();
}

function normalizeEntityName(name: string): string {
  return (name || "").toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const payload = await req.json();
      const licenseNumber = typeof payload.license_number === "string" ? payload.license_number.trim() : "";
      const licenseType = typeof payload.license_type === "string" ? payload.license_type.trim() : "";
      const entityName = typeof payload.entity_name === "string" ? payload.entity_name.trim() : "";

      let lastName = typeof payload.last_name === "string" ? payload.last_name.trim() : "";
      let firstName = typeof payload.first_name === "string" ? payload.first_name.trim() : "";
      if (!lastName && !entityName && typeof payload.full_name === "string" && payload.full_name.trim()) {
        // Same first-token/remainder convention as verify-dbpr-license's own full_name field.
        const parts = payload.full_name.trim().split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      if (!lastName && !entityName && !licenseNumber) {
        return new Response(JSON.stringify({ ok: false, error: "last_name (or full_name), entity_name, or license_number is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const clauses: string[] = [];
      if (lastName) clauses.push(soqlUpperEquals("lastname", lastName));
      if (firstName) clauses.push(soqlUpperEquals("firstname", firstName));
      if (entityName) clauses.push(soqlUpperEquals("entityname", entityName));
      if (licenseNumber) clauses.push(soqlUpperEquals("licensenumber", licenseNumber));
      if (licenseType) clauses.push(soqlUpperEquals("licensetype", licenseType));
      const whereClause = clauses.join(" AND ");

      const result = await querySocrata<CoLicenseRow>(CONFIG, whereClause, 25);
      if (!result.ok) {
        return new Response(JSON.stringify({ ok: false, error: result.error, status: result.status, detail: result.detail }), {
          status: result.error === "socrata_rate_limited" ? 429 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = result.rows;
      const searchMode = entityName ? "entity" : lastName ? "name" : "license_number";

      if (rows.length === 0) {
        return new Response(JSON.stringify({ ok: true, found: false, searchMode, matches: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Sanity-check the shape — a row must have at least a name field of some kind and a status,
      // or Colorado changed something this doesn't understand yet.
      if (rows.some((r) => typeof r.licensestatusdescription !== "string" || (!r.lastname && !r.entityname))) {
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "a row was missing an expected name or status field" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const searchPersonNorm = lastName ? normalizePersonName(lastName, firstName) : null;
      const searchEntityNorm = entityName ? normalizeEntityName(entityName) : null;

      const matches = rows.map((row) => {
        const displayName = row.entityname
          ? row.entityname
          : [row.lastname, [row.firstname, row.middlename].filter(Boolean).join(" ")].filter(Boolean).join(", ");

        let exactMatch: boolean | null = null;
        if (searchEntityNorm) {
          exactMatch = normalizeEntityName(row.entityname || "") === searchEntityNorm;
        } else if (searchPersonNorm) {
          const rowNorm = normalizePersonName(row.lastname || "", row.firstname || "");
          exactMatch = rowNorm === searchPersonNorm;
        }
        // else: a bare license-number search with no name/entity to compare against — stays null.

        return {
          name: displayName,
          exactMatch,
          licenseType: row.licensetype || null,
          subCategory: row.subcategory || null,
          licenseNumber: row.licensenumber || null,
          status: row.licensestatusdescription || null,
          expirationDate: row.licenseexpirationdate ? row.licenseexpirationdate.slice(0, 10) : null,
          city: row.city || null,
          state: row.state || null,
          verifyUrl: (row.linktoverifylicense && row.linktoverifylicense.url) || null,
        };
      });

      return new Response(JSON.stringify({
        ok: true,
        found: true,
        searchMode,
        matches, // every row Socrata returned, each flagged exactMatch true/false/null — a common
                 // name search will often be genuinely ambiguous (see the header comment above)
                 // and is surfaced as such rather than resolved to a guess
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
