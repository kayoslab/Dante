import Decimal from "decimal.js";

// ---------------------------------------------------------------------------
// Pure forecast math — no DB, no I/O, so it's unit-testable in isolation.
// The Forecast report converts planned *allocation* (a fraction of FTE) into
// planned *hours*, then derives a realization ratio (actual ÷ planned) and
// projects it forward. See `forecast.ts` for how these feed the rollups.
// ---------------------------------------------------------------------------

/** Planned hours for a window = allocation × daily hours × working days.
 *
 * `alloc` already encodes per-day intensity prorated over the window (see
 * `employeeWeightedAllocInMonth`), so multiplying by the window's daily
 * hours and working-day count yields the hours actually planned. `alloc`
 * can exceed 1 (overbooked) — that's intentional and flows through. */
export function plannedHours(
  alloc: Decimal,
  dailyHours: Decimal,
  workdays: number,
): Decimal {
  return alloc.mul(dailyHours).mul(workdays);
}

/** Realization ratio = actual worked hours ÷ planned hours, for the same
 * elapsed window. Null when nothing was planned (can't divide, and a ratio
 * off a zero base is meaningless). Never negative — actual/planned are both
 * ≥ 0. Can exceed 1 (delivered more than planned). */
export function realizationRatio(
  actual: Decimal,
  planned: Decimal,
): Decimal | null {
  if (planned.lte(0)) return null;
  return actual.div(planned);
}

/** Project an assumed actual for a month by applying the current
 * realization ratio to that month's planned hours. Null when there's no
 * ratio yet (nothing planned-to-date to measure against). */
export function projectAssumed(
  planned: Decimal,
  ratio: Decimal | null,
): Decimal | null {
  if (ratio === null) return null;
  return planned.mul(ratio);
}

/** Split available capacity into allocated / bench / overbooked.
 *
 * `available` = paid capacity minus paid vacation (the time actually
 * workable; unpaid leave is already out of capacity). Allocated is capped at
 * available, so **allocated + bench always equals available** — a clean 100%
 * partition of the workable time. Anything planned beyond available is
 * `overbook` (surfaced separately, "beyond 100%"), NOT negative bench.
 * `available` is clamped at 0 (a fully-off month has no workable capacity).
 */
export function splitAvailableCapacity(
  available: Decimal,
  allocation: Decimal,
): { allocated: Decimal; bench: Decimal; overbook: Decimal } {
  const avail = available.gt(0) ? available : new Decimal(0);
  const allocated = Decimal.min(allocation, avail);
  const bench = avail.sub(allocated);
  const overbook = allocation.gt(avail) ? allocation.sub(avail) : new Decimal(0);
  return { allocated, bench, overbook };
}
