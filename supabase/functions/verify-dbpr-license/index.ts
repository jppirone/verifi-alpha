// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Florida DBPR (myfloridalicense.com) license search — covers contractors, real estate,
// cosmetology, CPAs, engineers, and 30+ other license types under one search form. Unrelated to
// Sunbiz/business-entity verification (verify-fl-sos-entity); different agency, different site,
// different failure modes. Two things verified by hand against the live site before writing this
// parser, both load-bearing for how it behaves:
//
// 1. Unlike Sunbiz, this site has NO Cloudflare-style bot wall anywhere in the flow — 8 for 8
//    real invocations from this function's actual home (Supabase's Edge Function network),
//    spaced 10-20+ seconds apart, all succeeded cleanly. The real hazard here is completely
//    different: wl11.asp is a stateful, session-cookie-bound, 3-step classic-ASP form (GET the
//    landing page for a session cookie -> POST the search-type selection -> POST the actual
//    search, all three carrying the same ASPSESSIONIDxxxx cookie), and classic ASP throws a
//    generic, detail-free "DBPR: Error Has Occured" page if the POSTed field set doesn't exactly
//    match what the real form would have submitted — including hidden fields with non-obvious
//    non-blank defaults (hDivision defaults to "ALL", not blank; RecsPerPage defaults to "10",
//    not blank; a blank RecsPerPage almost certainly fails a numeric cast server-side). Getting
//    this wrong looks identical to a real server error, not a bot block, and the DBPR_ERROR_MARKER
//    check below exists specifically so a future field-default change on DBPR's end surfaces as
//    its own labeled failure (error: "dbpr_form_error") instead of silently being read as
//    found:false. This is the fragility that actually matters for this integration.
// 2. DBPR's Name search is a real filter, not Sunbiz's "nearest alphabetical neighbor" browse.
//    Verified live: searching a distinctive real name (LastName="Abounader Smith",
//    FirstName="Judith") returned exactly that one record; a fabricated name
//    (LastName="Nonexistentlastname12345") returned zero rows and DBPR's own
//    "no records found" message; a name matching two real, distinct license records
//    (LastName="Aguilar-Smith", FirstName="Paula" -- one active Cosmetologist license, one
//    separate "Application in Progress" Cosmetologist license) returned both. Because of that
//    last case, and per design: this function never picks a single "best" row the way
//    verify-fl-sos-entity does. It returns every row DBPR's own search returned, each flagged
//    exactMatch true/false against the name supplied, and leaves picking among them to staff.
//    Also verified: a license number can itself resolve to more than one row -- DBPR lists a
//    business's license and its qualifying individual's license as separate rows sharing the same
//    license number and detail id (CFC056678 -> both "AARDVARK PLUMBING INC" and
//    "SMITH, LAWRENCE C"). That's expected DBPR structure, not a parsing bug.
//
// If DBPR changes its markup, the row-parsing regex below will stop matching and this reports
// unexpected_response_shape rather than quietly returning found:false.

const DBPR_ERROR_MARKER = "Error Has Occured";
const NO_RECORDS_MARKER = "no records found";

const BASE = "https://www.myfloridalicense.com/wl11.asp";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractCookies(res: Response): string[] {
  const anyHeaders = res.headers as any;
  const raw: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  return raw.map((c) => c.split(";")[0]);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// DBPR names come back as "LAST[ MIDDLE-ish], FIRST MIDDLE" (comma-separated, last name first).
// Normalizes to "LAST FIRST MIDDLE..." with hyphens/punctuation flattened to spaces, for
// comparing against a candidate-supplied name of the same shape.
function normalizeDbprName(name: string): string {
  const decoded = decodeHtmlEntities(name).toUpperCase();
  const [lastPart, restPart] = decoded.split(",", 2);
  const flat = (s: string) => s.replace(/[-.]/g, " ").replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return restPart !== undefined ? `${flat(lastPart)} ${flat(restPart)}`.replace(/\s+/g, " ").trim() : flat(decoded);
}

function normalizeSearchName(lastName: string, firstName: string): string {
  const flat = (s: string) => s.replace(/[-.]/g, " ").replace(/[^A-Za-z0-9 ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  return `${flat(lastName)} ${flat(firstName)}`.replace(/\s+/g, " ").trim();
}

type Row = {
  licenseType: string;
  detailId: string;
  name: string;
  nameType: string;
  licenseNumber: string;
  rank: string;
  status: string;
  expirationDate: string;
  mainAddress: string;
};

// Matches DBPR's real, verified-live row markup exactly: each licensee is TWO adjacent
// <tr height='40'> blocks glued together (results row + a nested-table address row), not one
// clean row. Confirmed correct against captured real responses for three different license
// types/boards (Real Estate, Cosmetology, Certified Plumbing Contractor) including rows with
// blank license number/rank/expiration (e.g. "Application in Progress" records).
// 2026-09-20: the address row that follows is NOT a fixed shape. A licensee with a business location has TWO address lines in it
// ("License Location Address*" and "Main Address*"), an individual only the second. The old single regex required exactly the
// one-address shape and so matched ZERO rows on any page where every row had a location (verify-license then reported
// lookup_failed for a real active contractor, SCC131151265). The five result cells are now matched on their own, and the Main Address
// is read out of the address block that follows, wherever it sits in it.
const ROW_HEAD_RE = /<tr height='40'><td colspan='1' width='20%' align='center' bgcolor='#[0-9a-fA-F]{6}'><font face=Arial color=#000000 size=-1>([^<]*)<\/font><\/td><td colspan='1' align='center' bgcolor='#[0-9a-fA-F]{6}'><font face=Arial color=#000000 size=-1><a href='LicenseDetail\.asp\?SID=&id=([0-9A-Fa-f]+)'>([^<]*)<\/a><\/font><\/td><td colspan='1' align='center' bgcolor='#[0-9a-fA-F]{6}'><font face=Arial color=#000000 size=-1>([^<]*)<\/font><\/td><td colspan='1' align='center' bgcolor='#[0-9a-fA-F]{6}'><font face=Arial color=#000000 size=-1>([^<]*)<br\/>([^<]*)<\/font><\/td><td colspan='1' align='center' bgcolor='#[0-9a-fA-F]{6}'><font face=Arial color=#000000 size=-1>([^<]*)<br\/>([^<]*)<\/font><\/td>(?=<tr height='40'> <td colspan='6')/g;

function parseRows(html: string): Row[] {
  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex since ROW_HEAD_RE is a shared module-level global-flag regex.
  ROW_HEAD_RE.lastIndex = 0;
  while ((m = ROW_HEAD_RE.exec(html)) !== null) {
    const blockStart = m.index + m[0].length;
    const blockEnd = html.indexOf("</table></td></tr>", blockStart);
    const block = blockEnd < 0 ? "" : html.slice(blockStart, blockEnd);
    const addr = block.match(/Main Address\*:<\/b><\/span><\/font><\/td>\s*<td[^>]*><font[^>]*>([^<]*)<\/font>/);
    rows.push({
      licenseType: decodeHtmlEntities(m[1].trim()),
      detailId: m[2].trim(),
      name: decodeHtmlEntities(m[3].trim()),
      nameType: decodeHtmlEntities(m[4].trim()),
      licenseNumber: m[5].trim(),
      rank: decodeHtmlEntities(m[6].trim()),
      status: decodeHtmlEntities(m[7].trim()).replace(/,$/, ""), // DBPR's own status text is inconsistent about a trailing comma
      expirationDate: m[8].trim(),
      mainAddress: addr ? decodeHtmlEntities(addr[1].trim()).replace(/\s+/g, " ").trim() : "",
    });
  }
  return rows;
}

// The three requests below are sequential and had no ceiling of their own (a slow myfloridalicense.com simply
// held the caller for as long as it liked). One shared signal bounds the whole search, bodies included; a timeout
// surfaces as this function's normal 500 {ok:false,error} which verify-license already handles as a failed lookup.
const DBPR_SEARCH_TIMEOUT_MS = 30_000;

async function dbprSearch(searchType: "Name" | "LicNbr", fields: [string, string][]): Promise<{ html: string; status: number }> {
  const signal = AbortSignal.timeout(DBPR_SEARCH_TIMEOUT_MS);
  const res1 = await fetch(BASE, { headers: { "User-Agent": UA }, signal });
  const cookieHeader = extractCookies(res1).join("; ");
  await res1.text();

  const res2 = await fetch(BASE + "?mode=1&SID=&brd=&typ=", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookieHeader },
    body: "SearchType=" + searchType,
    signal,
  });
  await res2.text();

  const body = new URLSearchParams(fields).toString();
  const res3 = await fetch(BASE + `?mode=2&search=${searchType}&SID=&brd=&typ=`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookieHeader },
    body,
    signal,
  });
  const html = await res3.text();
  return { html, status: res3.status };
}

const HIDDEN_DEFAULTS: [string, string][] = [
  ["hSID", ""], ["hLastName", ""], ["hFirstName", ""], ["hMiddleName", ""],
  ["hOrgName", ""], ["hSearchOpt", ""], ["hSearchOpt2", ""], ["hSearchAltName", ""], ["hSearchPartName", ""],
  ["hSearchFuzzy", ""], ["hDivision", "ALL"], ["hBoard", ""], ["hLicenseType", ""], ["hSpecQual", ""],
  ["hAddrType", ""], ["hCity", ""], ["hCounty", ""], ["hState", ""], ["hLicNbr", ""], ["hAction", ""],
  ["hCurrPage", ""], ["hTotalPages", ""], ["hTotalRecords", ""], ["hPageAction", ""], ["hDDChange", ""],
  ["hBoardType", ""], ["hLicTyp", ""], ["hSearchHistoric", ""], ["hRecsPerPage", ""],
];

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
      const payload = await req.json();
      const licenseNumber = typeof payload.license_number === "string" ? payload.license_number.trim() : "";

      let lastName = typeof payload.last_name === "string" ? payload.last_name.trim() : "";
      let firstName = typeof payload.first_name === "string" ? payload.first_name.trim() : "";
      if (!lastName && typeof payload.full_name === "string" && payload.full_name.trim()) {
        // Convenience split: DBPR's own naming convention here is "first token = first name,
        // remainder = last name" (confirmed live: "Judith Abounader Smith" needed
        // FirstName="Judith", LastName="Abounader Smith" to find the real record). A middle name
        // given as part of full_name will end up folded into last_name by this heuristic — pass
        // first_name/last_name explicitly to avoid that.
        const parts = payload.full_name.trim().split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      if (!licenseNumber && !lastName) {
        return new Response(JSON.stringify({ ok: false, error: "last_name (or full_name) or license_number is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const searchType: "Name" | "LicNbr" = licenseNumber ? "LicNbr" : "Name";
      const fields: [string, string][] = licenseNumber
        ? [...HIDDEN_DEFAULTS, ["hSearchType", "LicNbr"], ["LicNbr", licenseNumber], ["RecsPerPage", "10"], ["Search1", "Search"]]
        : [...HIDDEN_DEFAULTS, ["hSearchType", "Name"], ["LastName", lastName], ["FirstName", firstName], ["MiddleName", ""], ["OrgName", ""], ["Board", " "], ["City", ""], ["County", ""], ["State", ""], ["RecsPerPage", "10"], ["Search1", "Search"]];

      const { html, status } = await dbprSearch(searchType, fields);

      if (html.includes(DBPR_ERROR_MARKER)) {
        return new Response(JSON.stringify({ ok: false, error: "dbpr_form_error", status, detail: "DBPR returned its generic classic-ASP error page instead of results; this means the request's field set no longer matches what the live form expects, not a bot block or a normal fetch failure" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!html.includes("Search Results")) {
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", status, detail: "response did not contain the expected 'Search Results' page structure" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (html.includes(NO_RECORDS_MARKER)) {
        return new Response(JSON.stringify({ ok: true, found: false, searchMode: searchType === "Name" ? "name" : "license_number", matches: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = parseRows(html);
      // Every result row carries exactly one detail link. Fewer parsed rows than links means a row shape we do not read: report it as
      // a shape problem rather than deciding on a silently shortened list.
      const detailLinks = (html.match(/LicenseDetail\.asp\?SID=&id=/g) || []).length;
      if (rows.length > 0 && rows.length < detailLinks) {
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "parsed " + rows.length + " of " + detailLinks + " result rows" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (rows.length === 0) {
        // "Search Results" header present, no "no records found" marker, yet nothing matched the
        // row regex — the page shape changed in some other way this hasn't seen before.
        return new Response(JSON.stringify({ ok: false, error: "unexpected_response_shape", detail: "results page present but no rows matched the expected row structure" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const searchNameNorm = lastName ? normalizeSearchName(lastName, firstName) : null;
      const searchLastNorm = lastName ? normalizeSearchName(lastName, "").trim() : null;

      const matches = rows.map((row) => {
        const rowNorm = normalizeDbprName(row.name);
        let exactMatch: boolean | null = null;
        if (searchNameNorm) {
          if (rowNorm === searchNameNorm) {
            exactMatch = true;
          } else if (searchLastNorm && rowNorm.startsWith(searchLastNorm + " ")) {
            // Last name matches and first name is present as a token (handles a DBPR middle
            // name/initial the candidate didn't supply) -> still exact; anything looser is fuzzy.
            const restTokens = rowNorm.slice(searchLastNorm.length + 1).split(" ");
            const firstTokenWanted = normalizeSearchName("", firstName).trim();
            exactMatch = firstTokenWanted.length > 0 && restTokens[0] === firstTokenWanted;
          } else {
            exactMatch = false;
          }
        }
        return {
          name: row.name,
          exactMatch, // null when no name was supplied to compare against (pure license-number lookup)
          licenseType: row.licenseType,
          nameType: row.nameType,
          licenseNumber: row.licenseNumber || null,
          rank: row.rank || null,
          status: row.status,
          expirationDate: row.expirationDate || null,
          mainAddress: row.mainAddress,
          detailId: row.detailId,
        };
      });

      return new Response(JSON.stringify({
        ok: true,
        found: true,
        searchMode: searchType === "Name" ? "name" : "license_number",
        matches, // every row DBPR returned, each flagged exactMatch true/false/null — picking among multiple real matches is a staff decision, not this function's
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
