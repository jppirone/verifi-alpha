// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Tier 1 employer existence check, hardened (2026-09-19).
//
// GATE (server-side, no bypass): the lookup only runs for a real, unused, unexpired confirmation
// token issued by send-lookup-confirmation to the REQUESTER's own email. There is no email/phone
// path any more — calling this without a valid token is a 400/404/409/410, never a lookup. The typed
// candidate details are read from the row staged at request time (not from this request), so they
// can't be changed between the email and the click.
//   token missing -> 400 token_required    unknown -> 404 not_found
//   already used  -> 409 already_used      expired -> 410 expired
//   genuine error -> 500 lookup_failed (a REAL error, distinguishable server-side; the token is NOT burned)
//
// BURN RULE: the token is marked used only by a completed lookup, via one conditional UPDATE
// (used_at is null AND not expired), performed AFTER the lookup succeeded and BEFORE the result is
// returned. A failed lookup never burns it; two concurrent uses can't both get a result.
//
// NO ORACLE: a genuine result is exists:true only for a candidate who (a) matches the email and/or
// phone, (b) matches the typed NAME (fuzzy, below), (c) opted in (discoverable), and (d) is not
// deactivated / scheduled for deletion. Every other genuine result — never registered, opted out,
// deactivated, name mismatch, contact mismatch — takes the same code path and returns the
// byte-identical {"ok":true,"exists":false}. Only a real internal failure differs, and it differs
// from ALL genuine results equally.
//
// MATCHING: email is case-insensitive; phone compares the last 10 digits (any formatting); when both
// email and phone are given they must match the SAME row. Only the signup email/phone on
// candidates are checked (not the KYC-verified number, and printed phone/email are never stored).

// BEGIN name matching
// Consistent with the project's other name matching (verify-dbpr-license): normalize case / punctuation
// / hyphens, last name must match, first name must match, a middle name or initial is tolerated. On top
// of that: diacritics, suffixes/titles, initials, common nicknames, and one-edit typos.
const NAME_SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "MD", "PHD", "ESQ"]);
const NAME_TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "PROF"]);
const NICKNAME_GROUPS: string[][] = [
  ["WILLIAM", "BILL", "WILL", "BILLY", "WILLY"], ["ROBERT", "BOB", "ROB", "BOBBY", "ROBBIE"],
  ["RICHARD", "RICK", "RICH", "DICK", "RICKY"], ["JAMES", "JIM", "JIMMY", "JAMIE"],
  ["JOHN", "JON", "JACK", "JOHNNY"], ["MICHAEL", "MIKE", "MICKEY"],
  ["ELIZABETH", "LIZ", "BETH", "BETSY", "LIZZIE", "ELIZA", "BETTY"],
  ["KATHERINE", "KATHRYN", "CATHERINE", "KATE", "KATIE", "KATHY", "CATHY", "KAT"],
  ["MARGARET", "MAGGIE", "PEGGY", "MEG", "MARGE"], ["THOMAS", "TOM", "TOMMY"],
  ["CHARLES", "CHUCK", "CHARLIE", "CHAS"], ["JOSEPH", "JOE", "JOEY"], ["DANIEL", "DAN", "DANNY"],
  ["MATTHEW", "MATT"], ["ANTHONY", "TONY"], ["CHRISTOPHER", "CHRIS", "KIT"], ["JENNIFER", "JEN", "JENNY"],
  ["PATRICIA", "PAT", "PATTY", "TRISH"], ["DEBORAH", "DEBRA", "DEB", "DEBBIE"], ["STEPHEN", "STEVEN", "STEVE"],
  ["ANDREW", "ANDY", "DREW"], ["EDWARD", "ED", "EDDIE", "TED", "NED"], ["NICHOLAS", "NICK", "NICKY"],
  ["SAMUEL", "SAM", "SAMMY"], ["BENJAMIN", "BEN", "BENNY"], ["ALEXANDER", "ALEX", "SANDY"],
  ["JONATHAN", "JON", "JONNY"], ["TIMOTHY", "TIM", "TIMMY"], ["DAVID", "DAVE", "DAVEY"],
  ["SUSAN", "SUE", "SUSIE"], ["REBECCA", "BECKY", "BECCA"], ["VICTORIA", "VICKY", "VIC"],
  ["JESSICA", "JESS", "JESSIE"], ["THEODORE", "TED", "THEO"], ["LAWRENCE", "LARRY"],
  ["RONALD", "RON", "RONNIE"], ["DONALD", "DON", "DONNIE"], ["KENNETH", "KEN", "KENNY"],
  ["GREGORY", "GREG"], ["PHILIP", "PHILLIP", "PHIL"], ["FREDERICK", "FRED", "FREDDIE"],
  ["ABIGAIL", "ABBY"], ["MARJORIE", "MARJORY", "MARGE", "MARGIE"], ["AMANDA", "MANDY"], ["SAMANTHA", "SAM"],
];
const NICKNAME_INDEX = new Map<string, number[]>();
NICKNAME_GROUPS.forEach((g, i) => g.forEach((n) => NICKNAME_INDEX.set(n, [...(NICKNAME_INDEX.get(n) || []), i])));

function nameTokens(s: string): string[] {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[-.'’,]/g, " ").replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/).filter((t) => t && !NAME_SUFFIXES.has(t) && !NAME_TITLES.has(t));
}
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
function lastNamesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  const allowed = m >= 8 ? 2 : m >= 5 ? 1 : 0;
  return allowed > 0 && editDistance(a, b) <= allowed;
}
function firstNamesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  const ga = NICKNAME_INDEX.get(a), gb = NICKNAME_INDEX.get(b);
  if (ga && gb && ga.some((g) => gb.includes(g))) return true;
  const m = Math.min(a.length, b.length);
  if (m >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  // one typo for names of 4+ letters, two for 7+ (Marjorie/Marjory, Katherine/Katharine)
  return m >= 4 && editDistance(a, b) <= (m >= 7 ? 2 : 1);
}
function namesMatch(typed: string, first: string | null, last: string | null, full: string | null): boolean {
  // "Last, First" ordering: a single comma flips the two halves.
  const commaParts = String(typed || "").split(",");
  const t = nameTokens(commaParts.length === 2 ? `${commaParts[1]} ${commaParts[0]}` : typed);
  if (t.length < 2) return false;
  let F = nameTokens(first || ""), L = nameTokens(last || "");
  if (!F.length || !L.length) {
    const f = nameTokens(full || "");
    if (f.length >= 2) { F = [f[0]]; L = f.slice(1); }
  }
  if (!F.length || !L.length) return false;
  const lastKey = L.join("");
  const candFirst = [F.join(""), F[0]];
  for (let k = 1; k <= Math.min(3, t.length - 1); k++) {
    if (!lastNamesMatch(t.slice(t.length - k).join(""), lastKey)) continue;
    const typedFirstTokens = t.slice(0, t.length - k);
    const typedFirst = [typedFirstTokens.join(""), typedFirstTokens[0]];
    for (const a of typedFirst) for (const b of candFirst) if (firstNamesMatch(a, b)) return true;
  }
  return false;
}
// END name matching

function digitsOf(s: string | null | undefined): string {
  return String(s || "").replace(/\D/g, "");
}
function phonesMatch(typedDigits: string, stored: string | null): boolean {
  const y = digitsOf(stored);
  if (typedDigits.length < 10 || y.length < 10) return false;
  return typedDigits.slice(-10) === y.slice(-10);
}

const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return json({ ok: false, error: "token_required" }, 400);

      const reqRes = await fetch(
        `${SUPABASE_URL}/rest/v1/employer_lookup_requests?token=eq.${encodeURIComponent(token)}&select=*`,
        { headers: REST },
      );
      if (!reqRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
      const row = (await reqRes.json())[0];
      if (!row) return json({ ok: false, error: "not_found" }, 404);
      if (row.used_at) return json({ ok: false, error: "already_used" }, 409);
      if (new Date(row.expires_at) < new Date()) return json({ ok: false, error: "expired" }, 410);

      // ---- the lookup itself, from the staged details ----
      const emailTyped = String(row.candidate_email || "").trim().toLowerCase();
      const phoneTyped = digitsOf(row.candidate_phone);
      const hasEmail = emailTyped.length > 0;
      const hasPhone = phoneTyped.length >= 10;
      let candidates: any[] = [];
      if (hasEmail || hasPhone) {
        const cols = "id,email,phone,first_name,last_name,full_name,discoverable,deletion_scheduled_at";
        // Fetch a superset (email ilike / phone contains last 4 digits), then decide in code.
        const filter = hasEmail
          ? `email=ilike.${encodeURIComponent(emailTyped.replace(/[*%]/g, ""))}&limit=10`
          : `phone=ilike.${encodeURIComponent("*" + phoneTyped.slice(-4) + "*")}&limit=50`;
        const cRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?select=${cols}&${filter}`, { headers: REST });
        if (!cRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
        candidates = await cRes.json();
        if (!Array.isArray(candidates)) return json({ ok: false, error: "lookup_failed" }, 500);
      }
      const matched = candidates.find((c) =>
        (!hasEmail || String(c.email || "").trim().toLowerCase() === emailTyped) &&
        (!hasPhone || phonesMatch(phoneTyped, c.phone)) &&
        c.discoverable === true &&
        !c.deletion_scheduled_at &&
        namesMatch(String(row.candidate_name || ""), c.first_name, c.last_name, c.full_name)
      ) || null;
      const exists = !!matched;

      // ---- burn the token: only now, only once, only if still valid ----
      const completedAt = new Date().toISOString();
      const claimRes = await fetch(
        `${SUPABASE_URL}/rest/v1/employer_lookup_requests?token=eq.${encodeURIComponent(token)}&used_at=is.null&expires_at=gt.${encodeURIComponent(completedAt)}`,
        {
          method: "PATCH",
          headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
          // The typed third-party details are scrubbed the moment the lookup completes.
          body: JSON.stringify({
            used_at: completedAt, result_exists: exists, matched_candidate_id: matched ? matched.id : null,
            candidate_name: null, candidate_email: null, candidate_phone: null,
          }),
        },
      );
      if (!claimRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
      const claimed = await claimRes.json();
      if (!Array.isArray(claimed) || claimed.length === 0) {
        // Lost a race (used by a concurrent call) or expired between the check and the claim.
        const again = await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests?token=eq.${encodeURIComponent(token)}&select=used_at`, { headers: REST });
        const r2 = again.ok ? (await again.json())[0] : null;
        return r2 && r2.used_at ? json({ ok: false, error: "already_used" }, 409) : json({ ok: false, error: "expired" }, 410);
      }

      if (!exists) return json({ ok: true, exists: false });
      return json({
        ok: true, exists: true,
        lookup_id: row.id, completed_at: completedAt,
        // Echo of what the requester themselves typed (the new page load has no other copy of it).
        candidate_name: row.candidate_name, contact_used: row.candidate_email || row.candidate_phone || "",
        requester_name: row.requester_name, requester_company: row.requester_company, requester_email: row.requester_email,
      });
    } catch (_e) {
      return json({ ok: false, error: "lookup_failed" }, 500);
    }
  }),
};
