// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Tier 1 employer existence check, hardened (2026-09-19; two entry paths since Gap #21, 2026-09-26).
//
// GATE (server-side, no bypass), TWO ways to satisfy it, both equally hard:
//   (a) a real, unused, unexpired confirmation token issued by send-lookup-confirmation to the requester's
//       own email (the original design: typed candidate details staged at request time, read from that row,
//       not from this request, so they can't change between the email and the click); or
//   (b) a live employer_sessions session_token (Gap #21: "one verification" -- the session itself is already
//       real proof of email control, so the candidate details can be taken directly from THIS call and staged
//       + burned in one step, no separate email round-trip).
// Calling this with neither a valid token nor a valid session is a 400/401/404/409/410, never a lookup.
//   token missing (and no session) -> 400 token_required    unknown token -> 404 not_found
//   already used  -> 409 already_used      expired -> 410 expired      bad/expired session -> 401 invalid_session
//   genuine error -> 500 lookup_failed (a REAL error, distinguishable server-side; nothing is burned)
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

// Gap #21 (2026-09-26), "one verification": a signed-in employer (employer_users/employer_sessions -- the
// same email-link login the account side already uses; org optional, no subscription needed) can run this
// lookup directly, with no separate send-lookup-confirmation email round-trip, because the session itself
// is already real proof of email control. Every hardening property below is unchanged either way: same
// fuzzy name matching, same byte-identical false-result shape, same one-shot "used" row -- this path just
// supplies that row itself, already staged AND already about to be burned, instead of reading one a
// separate email click staged earlier. A per-requester-email rate limit is added here specifically for
// this path (the anonymous path's equivalent limit lives in send-lookup-confirmation, at send time).
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function employerFromSession(sessionToken: unknown): Promise<{ id: string; email: string; name: string | null } | null> {
  if (typeof sessionToken !== "string" || sessionToken.length < 20 || sessionToken.length > 200) return null;
  const hash = await sha256Hex(sessionToken);
  const sRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_sessions?token_hash=eq.${hash}&select=employer_user_id,expires_at,revoked_at`, { headers: REST });
  if (!sRes.ok) return null;
  const sess = (await sRes.json())[0];
  if (!sess || sess.revoked_at || new Date(sess.expires_at) < new Date()) return null;
  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_users?id=eq.${sess.employer_user_id}&select=id,email,name`, { headers: REST });
  if (!uRes.ok) return null;
  return (await uRes.json())[0] || null;
}
const SESSION_REQUESTS_PER_HOUR = 5;
function clip(v: unknown, n: number): string {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const sessionToken = typeof body.session_token === "string" ? body.session_token : "";
      let row: any;

      if (!token && sessionToken) {
        // ---- session-authenticated path (Gap #21): stage-and-burn in one step, no separate email ----
        const employer = await employerFromSession(sessionToken);
        if (!employer) return json({ ok: false, error: "invalid_session" }, 401);
        const candidateName = clip(body.candidate_name, 160);
        const candidateEmail = clip(body.candidate_email, 254);
        const candidatePhone = clip(body.candidate_phone, 40);
        const requesterCompany = clip(body.requester_company, 160);
        if (candidateName.split(/\s+/).filter(Boolean).length < 2) return json({ ok: false, error: "candidate_name_required" }, 400);
        const phoneDigits = candidatePhone.replace(/\D/g, "");
        if (!candidateEmail && phoneDigits.length < 10) return json({ ok: false, error: "candidate_contact_required" }, 400);
        if (candidateEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)) return json({ ok: false, error: "candidate_email_invalid" }, 400);

        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const rlRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests?requester_email=eq.${encodeURIComponent(employer.email)}&created_at=gte.${encodeURIComponent(since)}&select=id`, { headers: REST });
        if (!rlRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
        const recent = await rlRes.json();
        if (Array.isArray(recent) && recent.length >= SESSION_REQUESTS_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);

        // expires_at is a few minutes out only as a safety buffer for the burn step below (a synchronous
        // continuation of this same call, not a real email-click window like the anonymous path's).
        const insRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests`, {
          method: "POST",
          headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({
            token: crypto.randomUUID(), requester_email: employer.email, requester_name: employer.name || employer.email,
            requester_company: requesterCompany || null, candidate_name: candidateName, candidate_email: candidateEmail || null,
            candidate_phone: candidatePhone || null, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          }),
        });
        if (!insRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
        row = (await insRes.json())[0];
        if (!row) return json({ ok: false, error: "lookup_failed" }, 500);
        // Remember the company typed, for next time's pre-fill (finding 1). Best-effort; never blocks the lookup.
        if (requesterCompany) {
          fetch(`${SUPABASE_URL}/rest/v1/employer_users?id=eq.${employer.id}`, {
            method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
            body: JSON.stringify({ last_company: requesterCompany }),
          }).catch(() => {});
        }
      } else {
        // ---- existing anonymous token path (unchanged) ----
        if (!token) return json({ ok: false, error: "token_required" }, 400);
        const reqRes = await fetch(
          `${SUPABASE_URL}/rest/v1/employer_lookup_requests?token=eq.${encodeURIComponent(token)}&select=*`,
          { headers: REST },
        );
        if (!reqRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
        row = (await reqRes.json())[0];
        if (!row) return json({ ok: false, error: "not_found" }, 404);
        if (row.used_at) return json({ ok: false, error: "already_used" }, 409);
        if (new Date(row.expires_at) < new Date()) return json({ ok: false, error: "expired" }, 410);
      }

      // ---- the lookup itself, from the staged details (shared by both paths) ----
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
      // Stage 3 (2026-09-20): a MATCHED lookup mints a one-time CLAIM token. Only its hash is stored (on the lookup); the token itself goes
      // back in this one response, to the browser that completed the lookup, and is what lets a guest (no employer account) request a
      // comparison later. A non-match mints and stores nothing, so the no-oracle guarantee is untouched.
      const claimToken = exists ? Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("") : null;
      const claimHash = claimToken ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(claimToken)))).map((b) => b.toString(16).padStart(2, "0")).join("") : null;

      // ---- burn the row: only now, only once, only if still valid. Keyed by id (not token) so this same
      // step works identically whether row came from the anonymous token path or the session path above. ----
      const completedAt = new Date().toISOString();
      const claimRes = await fetch(
        `${SUPABASE_URL}/rest/v1/employer_lookup_requests?id=eq.${row.id}&used_at=is.null&expires_at=gt.${encodeURIComponent(completedAt)}`,
        {
          method: "PATCH",
          headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
          // The typed third-party details are scrubbed the moment the lookup completes. ONE exception (2026-09-20): for a MATCHED lookup
          // only, the NAME the requester typed is kept in candidate_label so the requester can recognize the lookup later (a signed-in
          // employer picks a past lookup to request a comparison from). It is the requester's own input, never the candidate's stored
          // name, and it is cleared after 30 days by cleanup_expired_employer_lookups. Email and phone are still scrubbed. A non-match
          // stores nothing, so the no-oracle guarantee is untouched.
          body: JSON.stringify({
            used_at: completedAt, result_exists: exists, matched_candidate_id: matched ? matched.id : null,
            candidate_label: matched ? String(row.candidate_name || "").slice(0, 120) || null : null,
            claim_token_hash: claimHash,
            candidate_name: null, candidate_email: null, candidate_phone: null,
          }),
        },
      );
      if (!claimRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
      const claimed = await claimRes.json();
      if (!Array.isArray(claimed) || claimed.length === 0) {
        // Lost a race (used by a concurrent call) or expired between the check and the claim.
        const again = await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests?id=eq.${row.id}&select=used_at`, { headers: REST });
        const r2 = again.ok ? (await again.json())[0] : null;
        return r2 && r2.used_at ? json({ ok: false, error: "already_used" }, 409) : json({ ok: false, error: "expired" }, 410);
      }

      if (!exists) return json({ ok: true, exists: false });
      return json({
        ok: true, exists: true,
        lookup_id: row.id, completed_at: completedAt, claim_token: claimToken,
        // Echo of what the requester themselves typed (the new page load has no other copy of it).
        candidate_name: row.candidate_name, contact_used: row.candidate_email || row.candidate_phone || "",
        requester_name: row.requester_name, requester_company: row.requester_company, requester_email: row.requester_email,
      });
    } catch (_e) {
      return json({ ok: false, error: "lookup_failed" }, 500);
    }
  }),
};
