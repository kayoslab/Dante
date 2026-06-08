/** Minimal typed fetch for `/api/*` routes.
 *
 * Replaces `openapi-fetch`. Handles path-segment substitution, query string
 * encoding, and the `{ detail, code }` error envelope. Use:
 *
 *   const customers = await apiGet<Customer[]>("/customers", { query: { sort } });
 *   const detail    = await apiGet<CustomerDetail>("/customers/{customer_id}",
 *                                                 { path: { customer_id } });
 */
import { APIError, isAPIError } from "./types";

export type ApiOpts = {
  query?: Record<string, string | number | boolean | undefined | null>;
  path?: Record<string, string | number>;
  signal?: AbortSignal;
};

function buildUrl(template: string, opts: ApiOpts): string {
  let url = template;
  if (opts.path) {
    for (const [k, v] of Object.entries(opts.path)) {
      url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
  }
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return `/api${url}`;
}

async function throwForError(r: Response): Promise<never> {
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* no JSON body */
  }
  if (isAPIError(body)) throw new APIError(body.detail, body.code);
  throw new APIError(`HTTP ${r.status}: ${r.statusText}`, "internal_error");
}

export async function apiGet<T>(template: string, opts: ApiOpts = {}): Promise<T> {
  const r = await fetch(buildUrl(template, opts), { signal: opts.signal });
  if (!r.ok) await throwForError(r);
  return (await r.json()) as T;
}
