/** Per-task in-memory cache for month-scoped report computations.
 *
 * The trend/series endpoints recompute 12+ historical months on every
 * request, yet a past month's inputs only change when a sync backfills
 * late-entered time or a retroactive salary lands — rare, and a short
 * TTL absorbs it. Caching ONLY months strictly before the current month
 * keeps the live month always fresh while turning the dominant cost of
 * every series request (the historical tail) into a hash lookup.
 *
 * In-flight dedup matters as much as the cache itself: a report page
 * fires its trend chart and KPI card queries simultaneously, and both
 * fan over the same months — without dedup they'd race to compute the
 * same month twice.
 *
 * Values are returned by reference; callers must treat them as frozen
 * (the routes only serialize them, which is why this is safe).
 */

const TTL_MS = 15 * 60 * 1000;

type Entry = { value: unknown; at: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Run `fn`, caching its result iff `monthYm` is a completed month.
 * `scope` namespaces independent computations; include any argument
 * that changes the result (beyond the month) in the scope string. */
export async function cachePastMonth<T>(
  scope: string,
  monthYm: string,
  fn: () => Promise<T>,
): Promise<T> {
  const currentYm = new Date().toISOString().slice(0, 7);
  if (monthYm >= currentYm) return fn();

  const key = `${scope}:${monthYm}`;
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const p = fn()
    .then((value) => {
      store.set(key, { value, at: Date.now() });
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p);
  return p;
}
