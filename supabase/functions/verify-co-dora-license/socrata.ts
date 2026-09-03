// Generic, config-driven Socrata (SODA API) client — meant to be reused, unchanged, by every
// state-registry integration built on Socrata's Open Data platform. Colorado is first; New York,
// Connecticut, Oregon, and Pennsylvania all publish their business-registry and/or professional-
// licensing data on the same platform, so adding one of them later should mean writing a new
// per-state config + a thin field-mapping wrapper, not re-deriving fetch/query/error-handling
// logic from scratch.
//
// Verified against the real Colorado datasets before this was written (both
// data.colorado.gov/resource/4ykn-tg5h.json — business entities — and .../7s5z-vewr.json — DORA
// licenses): unauthenticated requests work fine at this volume (no app token configured or
// required below; Socrata's own docs say a token raises your throttle ceiling, not that one is
// required for reads, and every real query made while building this — dozens, unauthenticated —
// succeeded with no 429 and no throttle-related header). If that ever stops being true in
// practice, requestsSocrata below reports socrata_rate_limited as its own distinct, labeled error
// (a 429), not folded into a generic fetch failure — same discipline as DBPR's dbpr_form_error.
//
// Deployment note: Supabase's dashboard "Code" editor (the only way any function in this project
// gets deployed — see the other verify-* functions) supports multiple files per function via
// "+ Add File", but has no mechanism to share one file ACROSS functions outside the CLI's
// _shared/ convention, which this project doesn't use. So "shared" here means "the same generic
// module gets pasted into each function that needs it, unchanged" — not "one file on disk two
// functions both read." A real next-state build is still mostly configuration: drop this file in
// verbatim, write a SocrataConfig + field mapping, done.

export interface SocrataConfig {
  domain: string; // e.g. "data.colorado.gov"
  datasetId: string; // the Socrata 4x4 resource id, e.g. "4ykn-tg5h"
  appToken?: string; // optional — see note above; unset today for every state using this
}

export type SocrataResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: "socrata_rate_limited" | "socrata_unexpected_response" | "fetch_failed"; status?: number; detail?: string };

// Escapes a value for safe embedding in a SoQL string literal — single-quote doubling, the same
// rule standard SQL uses. Every value interpolated into a $where clause in this project goes
// through this first; never build a $where string by concatenating raw user input.
export function soqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

// Case-insensitive exact-equality SoQL fragment: upper(field) = 'VALUE'.
export function soqlUpperEquals(field: string, value: string): string {
  return "upper(" + field + ") = " + soqlString(value.toUpperCase());
}

export async function querySocrata<T = Record<string, unknown>>(
  config: SocrataConfig,
  whereClause: string,
  limit = 20,
): Promise<SocrataResult<T>> {
  const url = new URL("https://" + config.domain + "/resource/" + config.datasetId + ".json");
  url.searchParams.set("$where", whereClause);
  url.searchParams.set("$limit", String(limit));
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (config.appToken) headers["X-App-Token"] = config.appToken;

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers });
  } catch (e) {
    return { ok: false, error: "fetch_failed", detail: String(e) };
  }

  if (res.status === 429) {
    return { ok: false, error: "socrata_rate_limited", status: res.status };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: "fetch_failed", status: res.status, detail: detail.slice(0, 500) };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "socrata_unexpected_response", detail: "response was not JSON" };
  }
  if (!Array.isArray(json)) {
    return { ok: false, error: "socrata_unexpected_response", detail: "response was not a JSON array of rows" };
  }
  return { ok: true, rows: json as T[] };
}

// Also full-text search (SoQL $q=) — a looser, Socrata-ranked search across a dataset's indexed
// text fields. Used as a fallback when an exact upper()= query comes back empty, so a real
// near-miss (punctuation, a missing "The", a suffix typo) still surfaces something instead of a
// flat not-found — every row returned this way must be treated as a fuzzy match, never exact,
// since $q doesn't guarantee the search term is a substring of any particular field.
export async function querySocrataFullText<T = Record<string, unknown>>(
  config: SocrataConfig,
  q: string,
  limit = 10,
): Promise<SocrataResult<T>> {
  const url = new URL("https://" + config.domain + "/resource/" + config.datasetId + ".json");
  url.searchParams.set("$q", q);
  url.searchParams.set("$limit", String(limit));
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (config.appToken) headers["X-App-Token"] = config.appToken;

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers });
  } catch (e) {
    return { ok: false, error: "fetch_failed", detail: String(e) };
  }
  if (res.status === 429) return { ok: false, error: "socrata_rate_limited", status: res.status };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: "fetch_failed", status: res.status, detail: detail.slice(0, 500) };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "socrata_unexpected_response", detail: "response was not JSON" };
  }
  if (!Array.isArray(json)) {
    return { ok: false, error: "socrata_unexpected_response", detail: "response was not a JSON array of rows" };
  }
  return { ok: true, rows: json as T[] };
}
