// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Credly badge pages (https://www.credly.com/badges/<uuid>[/public_url]) render entirely
// client-side: the server HTML's <main id="root"> ships empty (verified by hand — curling a real
// public badge page returns only <head> meta tags, no badge content anywhere in the response).
// The page's own front-end fills itself in by calling an unauthenticated JSON endpoint:
//   GET https://www.credly.com/api/v1/public_badges/<uuid>
// That's what this function calls. It is NOT Credly's authenticated Organization API (the one
// that needs an API key for bulk/org-level verification) — it's the same anonymous, public data
// the badge page itself loads for any visitor who opens the link. It is, however, undocumented
// and unversioned as a public contract, so it carries the same fragility as HTML scraping: if
// Credly changes this response's shape, every unexpected_response_shape check below exists so
// that shows up as a reported error, not a silently-wrong "found: false".

function extractBadgeId(badgeUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(badgeUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)credly\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/badges\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { badge_url } = await req.json();
      if (!badge_url || typeof badge_url !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "badge_url is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const badgeId = extractBadgeId(badge_url);
      if (!badgeId) {
        return new Response(JSON.stringify({ ok: false, error: "not_a_credly_badge_url" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const apiUrl = "https://www.credly.com/api/v1/public_badges/" + badgeId;
      const res = await fetch(apiUrl, { headers: { "Accept": "application/json" } });

      if (res.status === 404) {
        return new Response(JSON.stringify({ ok: true, found: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", status: res.status, detail: detail.slice(0, 500) }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let json: any;
      try {
        json = await res.json();
      } catch {
        // A 200 that wasn't JSON at all — e.g. an HTML interstitial. That's Credly serving
        // something other than what we expect; say so instead of guessing at content.
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "response was not JSON" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const data = json && json.data;
      const badgeName = data && data.badge_template && data.badge_template.name;
      const issuedDate = data && data.issued_at_date;
      const entities = data && data.issuer && data.issuer.entities;
      const primaryIssuer = Array.isArray(entities)
        ? entities.find((e: any) => e && e.primary && e.entity && e.entity.type === "Organization")
        : null;
      const issuer = (primaryIssuer && primaryIssuer.entity && primaryIssuer.entity.name)
        || (data && data.issuer && data.issuer.summary && String(data.issuer.summary).replace(/^issued by /i, ""))
        || null;

      if (!badgeName || !issuer || !issuedDate) {
        // Parsed as JSON but didn't have the fields we rely on — Credly changed the shape of
        // this endpoint. Report that explicitly rather than returning nulls as if the badge
        // itself simply lacked that information.
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "missing expected badge fields" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, found: true, badgeName, issuer, issuedDate }), {
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
