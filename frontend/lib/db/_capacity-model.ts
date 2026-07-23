/** Central capacity / utilization model for the Forecast report.
 *
 * ONE definition of how an employee's paid capacity in a month is partitioned,
 * used by every section of `/reports/forecast` (per-team, per-role, per-
 * consultant tables AND the capacity breakdown) so the whole report tells one
 * consistent story. No section re-derives planned/actual/bench on its own.
 *
 * The partition of AVAILABLE hours (= capacity − paid absence):
 *
 *   available
 *   ├─ on_project_billable    engaged capacity on BILLABLE work    ← revenue time
 *   ├─ on_project_nonbillable engaged capacity on non-billable /   ← planned
 *   │                         internal projects                      internal
 *   └─ bench                  max(0, available − max(planned_total,← UNUSED capacity
 *                                               actual_billable))
 *
 * The billable / non-billable split is PLAN-based (planned billable allocation),
 * so a mostly-billable plan reads as billable in the current AND future months —
 * it does NOT depend on how much has been *tracked* month-to-date. Actual
 * billable delivery only raises the billable figure when it exceeds the plan
 * (`max(planned_billable, actual_billable)`), so picking up unplanned billable
 * work shows as billable rather than bench.
 *
 * Bench is UNUSED capacity, per the C-level definition:
 *  - Driven by the PLAN: someone allocated to a project is not on bench, even if
 *    they book internal time.
 *  - Actual billable work REDUCES bench: delivering above your allocation (or
 *    picking up unplanned billable work) shrinks unused capacity. Hence
 *    `max(planned_total, actual_billable)` — whichever engaged more capacity.
 *  - Under-delivering an allocation never CREATES bench (you were still booked).
 *
 * `over` is allocation/delivery beyond FULL capacity (genuine over-allocation).
 * Paid absence sits outside `available` entirely (no billable expectation).
 *
 * With `actual_billable = 0` (e.g. future months, no bookings yet) this is the
 * pure planned view: available → planned billable + planned non-billable + bench.
 *
 * This module is PURE (no DB) so the bucketing is unit-testable in isolation;
 * the allocation-split query lives in `_monthly-helpers.ts`.
 */
import Decimal from "decimal.js";

const D0 = new Decimal(0);
const dmax = (a: Decimal, b: Decimal): Decimal => (a.gt(b) ? a : b);
const dmin = (a: Decimal, b: Decimal): Decimal => (a.lt(b) ? a : b);
const clamp0 = (a: Decimal): Decimal => (a.gt(0) ? a : D0);

export type CapacityInput = {
  /** Paid capacity hours: contract working days × daily hours, minus unpaid leave. */
  capacity: Decimal;
  /** Paid absence hours (vacation / paid leave) — removed from `available`. */
  vacation: Decimal;
  /** Planned allocation hours across ALL projects (the assignment plan). */
  planned_total: Decimal;
  /** Planned allocation hours on BILLABLE projects (⊆ planned_total). */
  planned_billable: Decimal;
  /** Booked BILLABLE hours (month-to-date for the current month; 0 for future). */
  actual_billable: Decimal;
};

export type CapacityBuckets = {
  available: Decimal;
  on_project_billable: Decimal;
  on_project_nonbillable: Decimal;
  bench: Decimal;
  over: Decimal;
};

/** Partition one (employee, month)'s capacity. See the module header for the
 * model. `on_project_billable + on_project_nonbillable + bench = available`
 * always; `over` is a separate beyond-full-capacity flag. */
export function capacityBuckets(inp: CapacityInput): CapacityBuckets {
  const capacity = clamp0(inp.capacity);
  const available = clamp0(capacity.sub(inp.vacation));
  const planned_total = clamp0(inp.planned_total);
  const planned_billable = dmin(clamp0(inp.planned_billable), planned_total);
  const actual_billable = clamp0(inp.actual_billable);

  // Total capacity engaged — by the plan OR by actual billable delivery,
  // whichever pulled in more of the person's time. Bench is the rest.
  const engagedTotal = dmax(planned_total, actual_billable);
  const bench = clamp0(available.sub(engagedTotal));
  const engaged = available.sub(bench); // = min(engagedTotal, available)
  // Billable share of engaged capacity: at least the planned billable
  // allocation, raised by any actual billable delivery beyond the plan.
  const on_project_billable = dmin(dmax(planned_billable, actual_billable), engaged);
  const on_project_nonbillable = clamp0(engaged.sub(on_project_billable));
  const over = clamp0(engagedTotal.sub(capacity));
  return { available, on_project_billable, on_project_nonbillable, bench, over };
}

/** Safe ratio helper for KPIs at a rollup level. Null when the denominator is
 * ≤ 0 (a ratio off an empty base is meaningless, not 0). */
export function ratioOrNull(num: Decimal, den: Decimal): Decimal | null {
  if (den.lte(0)) return null;
  return num.div(den);
}

// ---------------------------------------------------------------------------
// Additive accumulator — every field is hours, so a rollup is summation and
// the KPIs (utilization %, bench %, delivery %) are computed from the sums.
// ---------------------------------------------------------------------------

export type CapacityAcc = {
  n: number;
  capacity: Decimal;
  vacation: Decimal;
  available: Decimal;
  /** Available capacity over ELAPSED working days (current month); equals
   * `available` for complete/future months. Utilization denominator. */
  available_to_date: Decimal;
  planned_total: Decimal;
  planned_billable: Decimal;
  planned_billable_to_date: Decimal;
  actual_billable: Decimal;
  actual_nonbillable: Decimal;
  on_project_billable: Decimal;
  on_project_nonbillable: Decimal;
  bench: Decimal;
  over: Decimal;
};

export function newCapacityAcc(): CapacityAcc {
  return {
    n: 0,
    capacity: D0,
    vacation: D0,
    available: D0,
    available_to_date: D0,
    planned_total: D0,
    planned_billable: D0,
    planned_billable_to_date: D0,
    actual_billable: D0,
    actual_nonbillable: D0,
    on_project_billable: D0,
    on_project_nonbillable: D0,
    bench: D0,
    over: D0,
  };
}

/** Per-(employee, month) contribution folded into an accumulator. */
export type CapacityContribution = {
  capacity: Decimal;
  vacation: Decimal;
  available_to_date: Decimal;
  planned_total: Decimal;
  planned_billable: Decimal;
  planned_billable_to_date: Decimal;
  actual_billable: Decimal;
  actual_nonbillable: Decimal;
  buckets: CapacityBuckets;
};

export function addToCapacityAcc(
  acc: CapacityAcc,
  c: CapacityContribution,
  countEmployee = true,
): void {
  if (countEmployee) acc.n += 1;
  acc.capacity = acc.capacity.add(c.capacity);
  acc.vacation = acc.vacation.add(c.vacation);
  acc.available = acc.available.add(c.buckets.available);
  acc.available_to_date = acc.available_to_date.add(c.available_to_date);
  acc.planned_total = acc.planned_total.add(c.planned_total);
  acc.planned_billable = acc.planned_billable.add(c.planned_billable);
  acc.planned_billable_to_date = acc.planned_billable_to_date.add(
    c.planned_billable_to_date,
  );
  acc.actual_billable = acc.actual_billable.add(c.actual_billable);
  acc.actual_nonbillable = acc.actual_nonbillable.add(c.actual_nonbillable);
  acc.on_project_billable = acc.on_project_billable.add(
    c.buckets.on_project_billable,
  );
  acc.on_project_nonbillable = acc.on_project_nonbillable.add(
    c.buckets.on_project_nonbillable,
  );
  acc.bench = acc.bench.add(c.buckets.bench);
  acc.over = acc.over.add(c.buckets.over);
}
