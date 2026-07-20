import { test } from "node:test";
import { strict as assert } from "node:assert";
import Decimal from "decimal.js";

import { capacityBuckets, ratioOrNull } from "./_capacity-model";

const d = (v: number | string) => new Decimal(v);
// A 160h full month (20 working days × 8h).
const bkt = (
  capacity: number,
  vacation: number,
  planned_total: number,
  planned_billable: number,
  actual_billable: number,
) =>
  capacityBuckets({
    capacity: d(capacity),
    vacation: d(vacation),
    planned_total: d(planned_total),
    planned_billable: d(planned_billable),
    actual_billable: d(actual_billable),
  });
// on_project_billable + on_project_nonbillable + bench = available, always.
function assertPartition(b: ReturnType<typeof capacityBuckets>) {
  assert.equal(
    b.on_project_billable
      .add(b.on_project_nonbillable)
      .add(b.bench)
      .toFixed(2),
    b.available.toFixed(2),
    "partition must sum to available",
  );
}

test("truly benched: no plan, no billable → all bench", () => {
  const b = bkt(160, 0, 0, 0, 0);
  assert.equal(b.available.toFixed(2), "160.00");
  assert.equal(b.bench.toFixed(2), "160.00");
  assert.equal(b.on_project_billable.toFixed(2), "0.00");
  assert.equal(b.on_project_nonbillable.toFixed(2), "0.00");
  assertPartition(b);
});

test("fully allocated billable + delivered (Ingo) → all billable, bench 0", () => {
  const b = bkt(160, 0, 160, 160, 160);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.on_project_billable.toFixed(2), "160.00");
  assertPartition(b);
});

test("allocated but under-delivers (meeting) → still billable-planned, bench 0", () => {
  // 100% billable-allocated, only 150h tracked so far. Capacity view is
  // plan-based → shows the 160h billable plan; the shortfall is a delivery
  // KPI, not a capacity bucket. Bench stays 0.
  const b = bkt(160, 0, 160, 160, 150);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.on_project_billable.toFixed(2), "160.00");
  assertPartition(b);
});

test("50% allocated but works 75% billable → extra billable shows, bench halves", () => {
  // planned 80h billable, delivered 120h → billable 120, bench 40 (not 80).
  const b = bkt(160, 0, 80, 80, 120);
  assert.equal(b.on_project_billable.toFixed(2), "120.00");
  assert.equal(b.bench.toFixed(2), "40.00");
  assertPartition(b);
});

test("future month (no actuals) shows the PLANNED billable, not zero", () => {
  // The bug: future allocations must read as billable, not "alloc-not-billed".
  const b = bkt(160, 0, 120, 120, 0);
  assert.equal(b.on_project_billable.toFixed(2), "120.00");
  assert.equal(b.on_project_nonbillable.toFixed(2), "0.00");
  assert.equal(b.bench.toFixed(2), "40.00");
  assertPartition(b);
});

test("current month, mostly-billable plan, partial tracking → NOT 50:50", () => {
  // The bug: 140h billable planned, only 60h tracked so far must still read as
  // ~140h billable (plan-based), not split billable/non-billable by to-date.
  const b = bkt(160, 0, 140, 140, 60);
  assert.equal(b.on_project_billable.toFixed(2), "140.00");
  assert.equal(b.on_project_nonbillable.toFixed(2), "0.00");
  assert.equal(b.bench.toFixed(2), "20.00");
  assertPartition(b);
});

test("genuine planned non-billable allocation shows as non-billable", () => {
  // 120h allocated, only 80h of it on billable projects → 40h internal.
  const b = bkt(160, 0, 120, 80, 0);
  assert.equal(b.on_project_billable.toFixed(2), "80.00");
  assert.equal(b.on_project_nonbillable.toFixed(2), "40.00");
  assert.equal(b.bench.toFixed(2), "40.00");
  assertPartition(b);
});

test("unplanned billable while on bench reduces bench, shows billable", () => {
  const b = bkt(160, 0, 0, 0, 80);
  assert.equal(b.on_project_billable.toFixed(2), "80.00");
  assert.equal(b.bench.toFixed(2), "80.00");
  assertPartition(b);
});

test("over-allocation beyond capacity → over flagged, bench 0", () => {
  const b = bkt(160, 0, 200, 200, 0);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.over.toFixed(2), "40.00");
  assert.equal(b.on_project_billable.toFixed(2), "160.00");
  assertPartition(b);
});

test("vacation removed from available; partition still holds", () => {
  const b = bkt(160, 40, 96, 96, 96);
  assert.equal(b.available.toFixed(2), "120.00");
  assert.equal(b.bench.toFixed(2), "24.00");
  assert.equal(b.on_project_billable.toFixed(2), "96.00");
  assertPartition(b);
});

test("billable overtime beyond capacity → capped, over flagged", () => {
  const b = bkt(160, 0, 160, 160, 180);
  assert.equal(b.on_project_billable.toFixed(2), "160.00"); // capped at available
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.over.toFixed(2), "20.00");
  assertPartition(b);
});

test("ratioOrNull: null on zero/negative denominator", () => {
  assert.equal(ratioOrNull(d(50), d(0)), null);
  assert.equal(ratioOrNull(d(50), d(-1)), null);
  assert.equal(ratioOrNull(d(96), d(160))!.toFixed(4), "0.6000");
});
