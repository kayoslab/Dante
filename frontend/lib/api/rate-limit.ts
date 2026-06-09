/** Per-user, per-scope token-bucket rate limit.
 *
 * Process-local Map. With `reserved_concurrent_executions = 2` on the
 * sync Lambda and 2 ECS tasks for the app, a hostile user is rate-limited
 * per-task — they still get 2× the per-task limit if they hit both
 * tasks evenly. That's acceptable trade-off for 40-user scale; a
 * distributed Redis-backed limit only earns its keep at higher traffic.
 *
 * The buckets Map grows with `(user_count × scope_count)` entries. At
 * 40 users × the half-dozen sensitive scopes used today, that's <300
 * entries — no eviction needed. Reconsider if scope count grows.
 *
 * The limit throws `HTTPError(429)` via the existing `handle()` envelope
 * so the FE gets a structured `{ detail, code: "rate_limited" }` response.
 */
import { HTTPError } from "./_route-helpers";

type Bucket = { tokens: number; updated_at: number };
const buckets = new Map<string, Bucket>();

/** Token-bucket check. Each call consumes one token; tokens refill at
 * `per_minute / 60000` per millisecond up to the bucket's burst capacity.
 *
 * `burst` defaults to `per_minute` (one full minute of capacity), which
 * is enough for a tab refresh that triggers 3-5 calls in a second
 * without false-positives, while still bounding a sustained loop. */
export function checkRateLimit(
  user_id: string,
  scope: string,
  opts: { per_minute: number; burst?: number },
): void {
  const burst = opts.burst ?? opts.per_minute;
  const key = `${scope}:${user_id}`;
  const now = Date.now();
  const refill_per_ms = opts.per_minute / 60000;
  const bucket: Bucket = buckets.get(key) ?? { tokens: burst, updated_at: now };
  const elapsed = now - bucket.updated_at;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refill_per_ms);
  if (bucket.tokens < 1) {
    throw new HTTPError(
      `Too many requests on ${scope}. Try again in a moment.`,
      429,
      "rate_limited",
    );
  }
  bucket.tokens -= 1;
  bucket.updated_at = now;
  buckets.set(key, bucket);
}
