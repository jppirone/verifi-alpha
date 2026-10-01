// One reusable Socrata (SODA 2.x) client for every state business-registry and licensing dataset published on an Open Data
// portal (2026-09-30). Supersedes the per-function copy in verify-co-sos-entity/socrata.ts for new work (those two functions
// are left untouched). What it adds over that copy, all required by the Stage 1 brief:
//   * AUTH: an optional app token (X-App-Token). Reads work unauthenticated; a token raises the per-IP throttle ceiling. Pass
//     it via the SOCRATA_APP_TOKEN secret -- none is configured today (registering one needs a person with an account).
//   * PAGINATION: paginate() walks $limit/$offset pages with a STABLE $order (Socrata does not guarantee page order without
//     one), up to a hard row cap so a bad query cannot run away.
//   * RATE-LIMIT HANDLING + RETRY: 429 and 5xx (and network errors / timeouts) are retried with exponential backoff and
//     jitter, honoring a Retry-After header when the server sends one. 4xx other than 429 are NOT retried (a malformed query
//     stays malformed). After the retries are spent the error is reported as its own labeled code, never folded into "not
//     found".
// Runtime-neutral: plain fetch, no Deno or Node APIs, so the same file runs in the edge functions and in the local test
// scripts. A test can inject `fetchImpl` and `sleepImpl`.

export interface SocrataConfig {
  domain: string; // e.g. "data.colorado.gov"
  datasetId: string; // the Socrata 4x4 resource id
  appToken?: string;
  maxRetries?: number; // default 4 (so up to 5 attempts)
  baseDelayMs?: number; // default 400
  maxDelayMs?: number; // default 8000
  timeoutMs?: number; // per attempt, default 20000
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type SocrataErrorCode =
  | "socrata_rate_limited" // still 429 after every retry
  | "socrata_unavailable" // still 5xx / network error / timeout after every retry
  | "socrata_bad_query" // 400/404 etc: the query or dataset id is wrong; never retried
  | "socrata_unexpected_response";

export type SocrataResult<T> =
  | { ok: true; rows: T[]; attempts: number }
  | { ok: false; error: SocrataErrorCode; status?: number; detail?: string; attempts: number };

export interface SoqlParams {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// Single-quote doubling, the SQL rule. Every user-supplied value that reaches a $where goes through this first.
export function soqlString(value: string): string { return "'" + value.replace(/'/g, "''") + "'"; }
export function soqlUpperEquals(field: string, value: string): string { return `upper(${field}) = ${soqlString(value.toUpperCase())}`; }
// upper(field) contains value (wildcards in the caller's text are stripped, so a caller cannot widen the match)
export function soqlUpperContains(field: string, value: string): string { return `upper(${field}) like ${soqlString("%" + value.replace(/[%_]/g, " ").replace(/\s+/g, " ").trim().toUpperCase() + "%")}`; }
export function soqlUpperPrefix(field: string, value: string): string { return `upper(${field}) like ${soqlString(value.toUpperCase() + "%")}`; }

const RETRY_STATUS = (s: number) => s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

export class SocrataClient {
  readonly config: Required<Pick<SocrataConfig, "domain" | "datasetId" | "maxRetries" | "baseDelayMs" | "maxDelayMs" | "timeoutMs">> & SocrataConfig;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  // Observability for callers and tests: how many HTTP attempts and how many were retried, cumulative on this client.
  stats = { requests: 0, retries: 0, rateLimited: 0 };

  constructor(cfg: SocrataConfig) {
    this.config = { maxRetries: 4, baseDelayMs: 400, maxDelayMs: 8000, timeoutMs: 20000, ...cfg };
    this.fetchImpl = cfg.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = cfg.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get sourceId(): string { return `${this.config.domain}/${this.config.datasetId}`; }

  url(p: SoqlParams): string {
    const u = new URL(`https://${this.config.domain}/resource/${this.config.datasetId}.json`);
    if (p.select) u.searchParams.set("$select", p.select);
    if (p.where) u.searchParams.set("$where", p.where);
    if (p.group) u.searchParams.set("$group", p.group);
    if (p.order) u.searchParams.set("$order", p.order);
    if (p.q) u.searchParams.set("$q", p.q);
    u.searchParams.set("$limit", String(p.limit ?? 20));
    if (p.offset) u.searchParams.set("$offset", String(p.offset));
    return u.toString();
  }

  private delayFor(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, this.config.maxDelayMs * 2);
      const when = Date.parse(retryAfter);
      if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), this.config.maxDelayMs * 2);
    }
    const exp = Math.min(this.config.baseDelayMs * 2 ** attempt, this.config.maxDelayMs);
    return exp / 2 + Math.random() * (exp / 2); // "equal jitter"
  }

  async query<T = Record<string, unknown>>(p: SoqlParams): Promise<SocrataResult<T>> {
    const url = this.url(p);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.appToken) headers["X-App-Token"] = this.config.appToken;
    let lastErr: { error: SocrataErrorCode; status?: number; detail?: string } = { error: "socrata_unavailable" };
    const total = this.config.maxRetries + 1;
    for (let attempt = 0; attempt < total; attempt++) {
      this.stats.requests++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.config.timeoutMs);
      let res: Response | null = null;
      let netErr: string | null = null;
      try { res = await this.fetchImpl(url, { headers, signal: ctl.signal }); } catch (e) { netErr = String(e); } finally { clearTimeout(timer); }

      if (res && res.ok) {
        let json: unknown;
        try { json = await res.json(); } catch { return { ok: false, error: "socrata_unexpected_response", detail: "response was not JSON", attempts: attempt + 1 }; }
        if (!Array.isArray(json)) return { ok: false, error: "socrata_unexpected_response", detail: "response was not a JSON array of rows", attempts: attempt + 1 };
        return { ok: true, rows: json as T[], attempts: attempt + 1 };
      }
      if (res && !RETRY_STATUS(res.status)) {
        const detail = (await res.text().catch(() => "")).slice(0, 500);
        return { ok: false, error: "socrata_bad_query", status: res.status, detail, attempts: attempt + 1 };
      }
      if (res) {
        if (res.status === 429) this.stats.rateLimited++;
        lastErr = { error: res.status === 429 ? "socrata_rate_limited" : "socrata_unavailable", status: res.status };
        await res.text().catch(() => "");
      } else {
        lastErr = { error: "socrata_unavailable", detail: netErr ?? "network error" };
      }
      if (attempt < total - 1) {
        this.stats.retries++;
        await this.sleep(this.delayFor(attempt, res ? res.headers.get("retry-after") : null));
      }
    }
    return { ok: false, ...lastErr, attempts: total };
  }

  // count(*) for a where clause; `distinct` counts distinct values of a field instead (dedup evidence).
  async count(where?: string, distinct?: string): Promise<{ ok: true; count: number } | { ok: false; error: SocrataErrorCode; detail?: string }> {
    const r = await this.query<Record<string, string>>({ select: distinct ? `count(distinct ${distinct}) as n` : "count(*) as n", where, limit: 1 });
    if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
    const n = Number(r.rows[0]?.n);
    return Number.isFinite(n) ? { ok: true, count: n } : { ok: false, error: "socrata_unexpected_response", detail: "count was not a number" };
  }

  // Walks every page of a query. `order` is REQUIRED for paging to be deterministic. Stops at maxRows.
  async *paginate<T = Record<string, unknown>>(p: Omit<SoqlParams, "offset" | "limit"> & { order: string; pageSize?: number; maxRows?: number }): AsyncGenerator<T[], void, void> {
    if (!p.order) throw new Error("paginate requires an $order: without one Socrata does not guarantee a stable page order");
    const pageSize = p.pageSize ?? 1000;
    const maxRows = p.maxRows ?? 50000;
    let offset = 0;
    while (offset < maxRows) {
      const r = await this.query<T>({ ...p, limit: Math.min(pageSize, maxRows - offset), offset });
      if (!r.ok) throw new Error(`${r.error}${r.status ? " " + r.status : ""}${r.detail ? ": " + r.detail : ""}`);
      if (r.rows.length === 0) return;
      yield r.rows;
      if (r.rows.length < Math.min(pageSize, maxRows - offset)) return;
      offset += r.rows.length;
    }
  }
}
