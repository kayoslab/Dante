/** Personio API client.
 *
 * Personio uses OAuth 2.0 client credentials. POST /auth returns a short-lived
 * bearer token; that token is then **rotated on every response** — each API
 * response carries a fresh `Authorization` header that must be used for the
 * next request, and the previous token is invalidated. This client tracks
 * the current token and re-authenticates on 401.
 *
 * Port of src/dante/client.py.
 */
import type { PersonioCredentials } from "@/lib/sync/credentials";

const API_BASE_V1 = "https://api.personio.de/v1";
const API_BASE_V2 = "https://api.personio.de/v2";

export class PersonioAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonioAuthError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for a 429/503 retry. Honours a `Retry-After` header (seconds
 * or HTTP-date) when Personio sends one; otherwise exponential backoff
 * with jitter (~0.5s, 1s, 2s, 4s, 8s), capped at 30s so a single stuck
 * request can't blow the sync Lambda's budget. */
function retryDelayMs(r: Response, attempt: number): number {
  const ra = r.headers.get("Retry-After");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
    const dateMs = Date.parse(ra);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), 30_000);
    }
  }
  const base = Math.min(500 * 2 ** attempt, 10_000);
  return base + Math.floor(Math.random() * 250);
}

export class PersonioClient {
  private token: string | null = null;
  constructor(private creds: PersonioCredentials) {}

  private async authenticate(): Promise<void> {
    const url = new URL(`${API_BASE_V1}/auth`);
    url.searchParams.set("client_id", this.creds.client_id);
    url.searchParams.set("client_secret", this.creds.client_secret);
    const r = await fetch(url, { method: "POST" });
    if (!r.ok) {
      throw new PersonioAuthError(
        `Authentication failed: ${r.status} ${await r.text()}`,
      );
    }
    const body = (await r.json()) as { data?: { token?: string } };
    const token = body.data?.token;
    if (!token) {
      throw new PersonioAuthError("No token in auth response");
    }
    this.token = token;
  }

  private async request(
    method: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (this.token === null) await this.authenticate();

    // Personio v2 enforces a strict rate limit. Cursor-paginated pulls
    // (a full year of attendance is ~100+ pages) trip it, and an
    // unhandled 429 aborts the whole sync step. Re-auth once on 401 and
    // back off + retry on 429/503 instead of throwing on the first one.
    let reauthed = false;
    let rateLimitRetries = 0;
    const MAX_RATE_LIMIT_RETRIES = 8;

    for (;;) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.token}`);
      const r = await fetch(url, { ...init, method, headers });

      // Token rotation — every response may carry a new bearer.
      const rotated = r.headers.get("Authorization");
      if (rotated) {
        const [scheme, value] = rotated.split(" ", 2);
        if (scheme && scheme.toLowerCase() === "bearer" && value) {
          this.token = value;
        }
      }

      if (r.status === 401 && !reauthed) {
        reauthed = true;
        await this.authenticate();
        continue;
      }

      if (
        (r.status === 429 || r.status === 503) &&
        rateLimitRetries < MAX_RATE_LIMIT_RETRIES
      ) {
        await sleep(retryDelayMs(r, rateLimitRetries));
        rateLimitRetries += 1;
        continue;
      }

      if (!r.ok) {
        throw new Error(
          `Personio ${method} ${url} → ${r.status} ${await r.text()}`,
        );
      }
      return r;
    }
  }

  async listEmployees(): Promise<unknown[]> {
    return this.paginate(`${API_BASE_V1}/company/employees`, {});
  }

  async listAbsences(
    start_date: string,
    end_date: string,
  ): Promise<unknown[]> {
    // /time-offs uses 1-indexed page numbers as `offset`, not row offsets.
    return this.paginate(
      `${API_BASE_V1}/company/time-offs`,
      { start_date, end_date },
      { pageIndexed: true },
    );
  }

  /** List Personio v2 /projects — the time-tracking project dropdown
   * consultants pick when logging attendance; `attendance.project_id`
   * references these. Cursor pagination like /v2/compensations. There is
   * no `updated_at` filter on this endpoint, so the full list is fetched
   * each run (small — one row per Personio project). */
  async listPersonioProjects(): Promise<unknown[]> {
    const items: unknown[] = [];
    let url: string | null = `${API_BASE_V2}/projects?limit=200`;
    while (url) {
      const r = await this.request("GET", url);
      const body = (await r.json()) as {
        _data?: unknown[];
        _meta?: { links?: { next?: { href?: string } } };
      };
      items.push(...(body._data ?? []));
      const next = body._meta?.links?.next?.href;
      url = next && next !== url ? next : null;
    }
    return items;
  }

  /** Walk Personio v2 /attendance-periods using cursor pagination.
   *
   * Returns raw period objects — BOTH `WORK` and `BREAK` types, because
   * v2 exposes no `type` query filter; the caller splits them. v2 models
   * a day as consecutive non-overlapping periods with breaks carved out
   * between work spans, so net worked time is `Σ(WORK.end − WORK.start)`
   * — no break subtraction (see `flattenAttendancePeriods`).
   *
   * Supply a window (`attribution_from`/`attribution_to` → the
   * `attribution_date` filter, which correctly attributes overnight
   * shifts to the right day) for a full backfill, and/or `updated_since`
   * (`updated_at.gte`) for an incremental delta pull — `updated_since`
   * MUST be a naive `YYYY-MM-DDTHH:MM:SS` (no `Z`/offset/fractional
   * seconds; v2 400s otherwise — see `attendanceMaxUpdatedAt`). `status`
   * is left
   * unfiltered so PENDING / CONFIRMED / REJECTED periods all come back —
   * matching the v1 sync, which counted all logged time. */
  async listAttendancePeriods(
    opts: {
      attribution_from?: string;
      attribution_to?: string;
      updated_since?: string;
    } = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const start = new URL(`${API_BASE_V2}/attendance-periods`);
    if (opts.attribution_from)
      start.searchParams.set("attribution_date.gte", opts.attribution_from);
    if (opts.attribution_to)
      start.searchParams.set("attribution_date.lte", opts.attribution_to);
    if (opts.updated_since)
      start.searchParams.set("updated_at.gte", opts.updated_since);
    start.searchParams.set("limit", "100");

    let url: string | null = start.toString();
    while (url) {
      const r = await this.request("GET", url);
      const body = (await r.json()) as {
        _data?: unknown[];
        _meta?: { links?: { next?: { href?: string } } };
      };
      items.push(...(body._data ?? []));
      const next = body._meta?.links?.next?.href;
      url = next && next !== url ? next : null;
    }
    return items;
  }

  async getPersonEmployments(person_id: number): Promise<unknown[]> {
    // v2 employments — captures actual leaving date (v1 only gives
    // contract_end_date for fixed-term contracts).
    const r = await this.request(
      "GET",
      `${API_BASE_V2}/persons/${person_id}/employments`,
    );
    const body = (await r.json()) as { _data?: unknown[] };
    return body._data ?? [];
  }

  /** Walk Personio v2 /compensations using cursor pagination.
   *
   * With no `as_of`, returns the current snapshot. With `as_of='YYYY-MM-DD'`,
   * returns the snapshot **active on that date** (start_date=end_date=as_of) —
   * used to reconstruct historical salary changes one step at a time.
   */
  async listCompensations(opts: { as_of?: string } = {}): Promise<unknown[]> {
    const items: unknown[] = [];
    const base = `${API_BASE_V2}/compensations`;
    let url: string | null = opts.as_of
      ? `${base}?start_date=${opts.as_of}&end_date=${opts.as_of}`
      : base;
    while (url) {
      const r = await this.request("GET", url);
      const body = (await r.json()) as {
        _data?: unknown[];
        _meta?: { links?: { next?: { href?: string } } };
      };
      items.push(...(body._data ?? []));
      const next = body._meta?.links?.next?.href;
      url = next && next !== url ? next : null;
    }
    return items;
  }

  private async paginate(
    base: string,
    params: Record<string, string>,
    opts: { pageIndexed?: boolean } = {},
  ): Promise<unknown[]> {
    const limit = 200;
    let offset = opts.pageIndexed ? 1 : 0;
    const step = opts.pageIndexed ? 1 : limit;
    const items: unknown[] = [];
    while (true) {
      const u = new URL(base);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("offset", String(offset));
      const r = await this.request("GET", u.toString());
      const body = (await r.json()) as { data?: unknown[] };
      const page = body.data ?? [];
      if (page.length === 0) break;
      items.push(...page);
      if (page.length < limit) break;
      offset += step;
    }
    return items;
  }
}
