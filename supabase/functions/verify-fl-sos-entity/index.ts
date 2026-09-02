// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Sunbiz (Florida Division of Corporations) has no public JSON API for entity search; this
// parses the same HTML results page a human searching the site would see. Two things verified by
// hand against the live site before writing this parser, both load-bearing for how it behaves:
//
// 1. The results-list page (SearchResults/EntityName/...) sits behind Cloudflare bot management.
//    From a residential/dev-machine IP it was fetchable directly most of the time, with an
//    occasional JS challenge ("Just a moment...") instead of the real page. From this function's
//    actual home — Supabase's Edge Function network — every real invocation made while building
//    this (6 for 6, spaced 8+ seconds apart, well after the fix below was deployed) was
//    challenged instead. That's consistent with Cloudflare scoring known cloud/datacenter IP
//    ranges harder than residential ones, though that's the likely explanation, not a proven one.
//    Bottom line: as hosted today, this function should be expected to report blocked_by_challenge
//    on most real calls, not to reliably reach Sunbiz's data — see the CF_CHALLENGE_MARKERS check
//    below, which exists specifically so that shows up as a labeled error instead of a false
//    "not found". The individual entity DETAIL page (linked off each result row) was challenged
//    on every attempt from anywhere and could not be fetched at all from a plain server-side
//    fetch; that's why filing type below is inferred from the entity's own matched name instead —
//    Florida law requires the type designator ("LLC", "Inc.", "L.P.", etc.) be part of the legal
//    name itself.
// 2. Sunbiz's name search is a "start browsing the alphabetical list here" search, not a filter:
//    a query with no real match still returns rows for whatever entities sort next to it
//    alphabetically. Searching "Related Ryan" (tested live) returns "Related Sales, LLC" and a
//    dozen more "Related S..." neighbors — a real company, the wrong company, with no indication
//    in the page itself that these aren't matches. Treating "the results table has rows" as
//    "found" would be wrong far more often than right. Below, found:true only fires when a row's
//    name actually matches the searched name after normalization (case, punctuation, a leading
//    "The", and — separately — the legal-entity suffix); every other row is disregarded, and a
//    suffix-only mismatch (LLC vs Inc, etc.) is reported as exactMatch:false rather than folded
//    silently into a confirmed hit.
//
// If Sunbiz changes its markup, the challenge check or the "search-results" div/table lookup
// below will stop finding what they expect (see the unexpected_response_shape checks) and this
// reports that plainly instead of quietly returning found:false.

const CF_CHALLENGE_MARKERS = ["Just a moment", "_cf_chl_opt", "challenge-platform"];

const SUFFIX_MAP: [RegExp, string][] = [
  [/\bL\.?L\.?C\.?$/i, "LLC"],
  [/\bL\.?L\.?P\.?$/i, "LLP"],
  [/\bLIMITED PARTNERSHIP$/i, "Limited Partnership"],
  [/\bL\.?P\.?$/i, "Limited Partnership"],
  [/\bP\.?L\.?L\.?C\.?$/i, "Professional LLC"],
  [/\bP\.?A\.?$/i, "Professional Association"],
  [/\b(INCORPORATED|INC\.?)$/i, "Corporation"],
  [/\b(CORPORATION|CORP\.?)$/i, "Corporation"],
  [/\bLTD\.?$/i, "Corporation"],
  [/\bCO\.?$/i, "Company"],
];

function inferFilingType(name: string): string | null {
  const trimmed = name.trim();
  for (const [re, label] of SUFFIX_MAP) {
    if (re.test(trimmed)) return label;
  }
  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeName(name: string): string {
  return decodeHtmlEntities(name)
    .toUpperCase()
    .replace(/^THE\s+/, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function coreName(name: string): string {
  // Strip a trailing legal-entity suffix so "Acme LLC" and "Acme, Inc." compare as the same
  // underlying business name, per the LLC-vs-Inc concern this function exists to not paper over.
  return normalizeName(name)
    .replace(/\s+(LLC|LLP|LP|PA|PLLC|INCORPORATED|INC|CORPORATION|CORP|CO|LTD|LIMITED PARTNERSHIP)$/i, "")
    .trim();
}

type Row = { name: string; docNumber: string; status: string };

function parseRows(html: string): Row[] {
  const rowRe = /<tr>\s*<td class="large-width"><a[^>]*>([^<]+)<\/a><\/td>\s*<td class="medium-width">([^<]*)<\/td>\s*<td class="small-width">([^<]*)<\/td>/g;
  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    rows.push({
      name: decodeHtmlEntities(m[1].trim()),
      docNumber: m[2].trim(),
      status: m[3].trim(),
    });
  }
  return rows;
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
      const searchNameOrder = searchTerm.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const url = "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults/EntityName/"
        + encodeURIComponent(searchTerm) + "/Page1?searchNameOrder=" + encodeURIComponent(searchNameOrder);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Read the body before branching on status: Cloudflare's bot-check page (checked for
      // below) commonly comes back as a 403, not a 200, so checking res.ok first would misfile
      // "we got challenged" as a generic fetch_failed instead of the more specific, more useful
      // blocked_by_challenge — and silently swallow the challenge HTML into a truncated "detail"
      // string instead of naming what actually happened.
      const html = await res.text();

      if (CF_CHALLENGE_MARKERS.some((marker) => html.includes(marker))) {
        return new Response(JSON.stringify({ ok: false, error: "blocked_by_challenge", status: res.status, detail: "Sunbiz served a bot-check page instead of results; retry" }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", status: res.status, detail: html.slice(0, 500) }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!html.includes('id="search-results"') || !html.includes("<table")) {
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "results page did not have the expected structure" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = parseRows(html);
      const searchCore = coreName(searchTerm);
      const searchNorm = normalizeName(searchTerm);

      let best: { row: Row; exact: boolean } | null = null;
      for (const row of rows) {
        const rowNorm = normalizeName(row.name);
        if (rowNorm === searchNorm) {
          best = { row, exact: true };
          break; // an exact match wins outright, stop looking
        }
        if (!best && searchCore.length > 0 && coreName(row.name) === searchCore) {
          best = { row, exact: false };
        }
      }

      if (!best) {
        return new Response(JSON.stringify({ ok: true, found: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        found: true,
        exactMatch: best.exact,
        matchedName: best.row.name,
        entityStatus: best.row.status,
        documentNumber: best.row.docNumber,
        filingType: inferFilingType(best.row.name),
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
