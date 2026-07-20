import { test } from "node:test";
import { strict as assert } from "node:assert";
import Decimal from "decimal.js";

import { capacityBuckets, ratioOrNull } from "./_capacity-model";

const d = (v: number | string) => new Decimal(v);
// A 160h full month (20 working days × 8h).
const bkt = (capacity: number, vacation: number, planned: number, actual_billable: number) =>
  capacityBuckets({
    capacity: d(capacity),
    vacation: d(vacation),
    planned: d(planned),
    actual_billable: d(actual_billable),
  });
// available = billable_delivered + allocated_not_billed + bench, always.
function assertPartition(b: ReturnType<typeof capacityBuckets>) {
  assert.equal(
    b.billable_delivered.add(b.allocated_not_billed).add(b.bench).toFixed(2),
    b.available.toFixed(2),
    "partition must sum to available",
  );
}

test("truly benched: no plan, no billable → all bench", () => {
  const b = bkt(160, 0, 0, 0);
  assert.equal(b.available.toFixed(2), "160.00");
  assert.equal(b.bench.toFixed(2), "160.00");
  assert.equal(b.billable_delivered.toFixed(2), "0.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "0.00");
  assert.equal(b.over.toFixed(2), "0.00");
  assertPartition(b);
});

test("fully allocated + delivered (Ingo, overtime lives elsewhere) → bench 0", () => {
  // Ingo: 100% allocated, delivers 160h billable; any internal overtime is
  // tracked as non-billable and doesn't enter the bucket inputs → bench 0.
  const b = bkt(160, 0, 160, 160);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.billable_delivered.toFixed(2), "160.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "0.00");
  assertPartition(b);
});

test("allocated but under-delivers (company meeting) → bench 0, gap is allocated_not_billed", () => {
  // 100% allocated, books 150h billable + 10h internal. Still not bench — they
  // were booked; the 10h shortfall is allocated-but-not-billed.
  const b = bkt(160, 0, 160, 150);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.billable_delivered.toFixed(2), "150.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "10.00");
  assertPartition(b);
});

test("50% allocated but works 75% billable → extra billable reduces bench", () => {
  // planned 80h (50%), delivered 120h (75%) → engaged 120 → bench 40 (not 80).
  const b = bkt(160, 0, 80, 120);
  assert.equal(b.bench.toFixed(2), "40.00");
  assert.equal(b.billable_delivered.toFixed(2), "120.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "0.00");
  assertPartition(b);
});

test("unplanned billable while on bench reduces bench", () => {
  // 0% allocated, picks up 80h billable → bench 80 (not 160).
  const b = bkt(160, 0, 0, 80);
  assert.equal(b.bench.toFixed(2), "80.00");
  assert.equal(b.billable_delivered.toFixed(2), "80.00");
  assertPartition(b);
});

test("over-allocation beyond capacity → over flagged, bench 0", () => {
  const b = bkt(160, 0, 200, 0);
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.over.toFixed(2), "40.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "160.00");
  assertPartition(b);
});

test("vacation removed from available; partition still holds", () => {
  // 160 capacity, 40 vacation → 120 available; planned 96, billable 96.
  const b = bkt(160, 40, 96, 96);
  assert.equal(b.available.toFixed(2), "120.00");
  assert.equal(b.bench.toFixed(2), "24.00");
  assert.equal(b.billable_delivered.toFixed(2), "96.00");
  assertPartition(b);
});

test("billable overtime beyond capacity → capped delivered, over flagged", () => {
  const b = bkt(160, 0, 160, 180);
  assert.equal(b.billable_delivered.toFixed(2), "160.00"); // capped at available
  assert.equal(b.bench.toFixed(2), "0.00");
  assert.equal(b.over.toFixed(2), "20.00");
  assertPartition(b);
});

test("future month (no actuals) reduces to the planned view", () => {
  // actual_billable 0 → bench = available − planned; matches old capacitySplit.
  const b = bkt(160, 0, 120, 0);
  assert.equal(b.bench.toFixed(2), "40.00");
  assert.equal(b.allocated_not_billed.toFixed(2), "120.00");
  assert.equal(b.billable_delivered.toFixed(2), "0.00");
  assertPartition(b);
});

test("ratioOrNull: null on zero/negative denominator", () => {
  assert.equal(ratioOrNull(d(50), d(0)), null);
  assert.equal(ratioOrNull(d(50), d(-1)), null);
  assert.equal(ratioOrNull(d(96), d(160))!.toFixed(4), "0.6000");
});
