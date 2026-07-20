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
 *   ├─ billable_delivered   min(actual_billable, available)      ← revenue time
 *   ├─ allocated_not_billed available − billable − bench         ← planned but
 *   │                                                              not billed:
 *   │                                                              meetings,
 *   │                                                              internal work,
 *   │                                                              under-delivery
 *   └─ bench                max(0, available − max(planned,       ← UNUSED capacity
 *                                              actual_billable))
 *
 * Bench is UNUSED capacity, per the C-level definition:
 *  - It's driven by the PLAN: someone allocated to a project is not on bench,
 *    even if they book internal time (that's `allocated_not_billed`, not bench).
 *  - Actual billable work REDUCES bench: picking up unplanned billable work (or
 *    delivering above your allocation) shrinks the unused-capacity figure. Hence
 *    `max(planned, actual_billable)` — whichever engaged more of your capacity.
 *  - Under-delivering an allocation never CREATES bench (you were still booked).
 *
 * `over` is allocation/delivery beyond FULL capacity (genuine over-allocation).
 * Paid absence sits outside `available` entirely (no billable expectation).
 *
 * With `actual_billable = 0` (e.g. future months, no bookings yet) this reduces
 * to the pure planned view: available → planned (capped) + bench + vacation.
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
  /** Planned allocation hours across all projects (the assignment plan). */
  planned: Decimal;
  /** Booked BILLABLE hours (month-to-date for the current month; 0 for future). */
  actual_billable: Decimal;
};

export type CapacityBuckets = {
  available: Decimal;
  billable_delivered: Decimal;
  allocated_not_billed: Decimal;
  bench: Decimal;
  over: Decimal;
};

/** Partition one (employee, month)'s capacity. See the module header for the
 * model. `billable_delivered + allocated_not_billed + bench = available`
 * always; `over` is a separate beyond-full-capacity flag. */
export function capacityBuckets(inp: CapacityInput): CapacityBuckets {
  const capacity = clamp0(inp.capacity);
  const available = clamp0(capacity.sub(inp.vacation));
  // Capacity that was engaged — by the plan OR by actual billable delivery,
  // whichever pulled in more of the person's time.
  const engaged = dmax(clamp0(inp.planned), clamp0(inp.actual_billable));
  const billable_delivered = dmin(clamp0(inp.actual_billable), available);
  const bench = clamp0(available.sub(engaged));
  const allocated_not_billed = clamp0(
    available.sub(billable_delivered).sub(bench),
  );
  const over = clamp0(engaged.sub(capacity));
  return { available, billable_delivered, allocated_not_billed, bench, over };
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
  planned_total: Decimal;
  planned_billable: Decimal;
  planned_billable_to_date: Decimal;
  actual_billable: Decimal;
  actual_nonbillable: Decimal;
  billable_delivered: Decimal;
  allocated_not_billed: Decimal;
  bench: Decimal;
  over: Decimal;
};

export function newCapacityAcc(): CapacityAcc {
  return {
    n: 0,
    capacity: D0,
    vacation: D0,
    available: D0,
    planned_total: D0,
    planned_billable: D0,
    planned_billable_to_date: D0,
    actual_billable: D0,
    actual_nonbillable: D0,
    billable_delivered: D0,
    allocated_not_billed: D0,
    bench: D0,
    over: D0,
  };
}

/** Per-(employee, month) contribution folded into an accumulator. */
export type CapacityContribution = {
  capacity: Decimal;
  vacation: Decimal;
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
  acc.planned_total = acc.planned_total.add(c.planned_total);
  acc.planned_billable = acc.planned_billable.add(c.planned_billable);
  acc.planned_billable_to_date = acc.planned_billable_to_date.add(
    c.planned_billable_to_date,
  );
  acc.actual_billable = acc.actual_billable.add(c.actual_billable);
  acc.actual_nonbillable = acc.actual_nonbillable.add(c.actual_nonbillable);
  acc.billable_delivered = acc.billable_delivered.add(
    c.buckets.billable_delivered,
  );
  acc.allocated_not_billed = acc.allocated_not_billed.add(
    c.buckets.allocated_not_billed,
  );
  acc.bench = acc.bench.add(c.buckets.bench);
  acc.over = acc.over.add(c.buckets.over);
}
