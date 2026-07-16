import { test } from "node:test";
import { strict as assert } from "node:assert";
import Decimal from "decimal.js";

import {
  plannedHours,
  realizationRatio,
  projectAssumed,
  splitAvailableCapacity,
} from "./_forecast-math";

const d = (v: number | string) => new Decimal(v);

test("plannedHours: alloc × dailyHours × workdays", () => {
  // 0.5 FTE on a project, 8h/day, 20 working days = 80h.
  assert.equal(plannedHours(d("0.5"), d(8), 20).toFixed(2), "80.00");
});

test("plannedHours: zero allocation → zero", () => {
  assert.equal(plannedHours(d(0), d(8), 22).toFixed(2), "0.00");
});

test("plannedHours: overbooked allocation flows through (>capacity)", () => {
  // 1.25 FTE (overbooked) × 8h × 20d = 200h > 160h capacity.
  assert.equal(plannedHours(d("1.25"), d(8), 20).toFixed(2), "200.00");
});

test("plannedHours: part-timer daily hours (30h/wk = 6h/day)", () => {
  assert.equal(plannedHours(d(1), d(6), 20).toFixed(2), "120.00");
});

test("realizationRatio: actual over planned", () => {
  assert.equal(realizationRatio(d(96), d(120))!.toFixed(4), "0.8000");
});

test("realizationRatio: null when nothing planned", () => {
  assert.equal(realizationRatio(d(40), d(0)), null);
  assert.equal(realizationRatio(d(0), d(0)), null);
});

test("realizationRatio: zero actual over positive planned → 0 (not null)", () => {
  const r = realizationRatio(d(0), d(100));
  assert.notEqual(r, null);
  assert.equal(r!.toFixed(2), "0.00");
});

test("realizationRatio: can exceed 1 (delivered more than planned)", () => {
  assert.equal(realizationRatio(d(130), d(100))!.toFixed(2), "1.30");
});

test("projectAssumed: planned × ratio", () => {
  // planned 120h next month, current ratio 0.8 → assumed 96h.
  assert.equal(projectAssumed(d(120), d("0.8"))!.toFixed(2), "96.00");
});

test("projectAssumed: null ratio → null (no basis to project)", () => {
  assert.equal(projectAssumed(d(120), null), null);
});

test("splitAvailableCapacity: allocated + bench = available (partition)", () => {
  // available 144h (160 capacity − 16 vacation), 120h allocated → 24h bench.
  const r = splitAvailableCapacity(d(144), d(120));
  assert.equal(r.allocated.toFixed(2), "120.00");
  assert.equal(r.bench.toFixed(2), "24.00");
  assert.equal(r.overbook.toFixed(2), "0.00");
  assert.equal(r.allocated.add(r.bench).toFixed(2), "144.00"); // = available
});

test("splitAvailableCapacity: overbooked → allocated capped, bench 0, excess in overbook", () => {
  // available 144h, planned 160h → allocated 144, bench 0, overbook 16.
  const r = splitAvailableCapacity(d(144), d(160));
  assert.equal(r.allocated.toFixed(2), "144.00");
  assert.equal(r.bench.toFixed(2), "0.00");
  assert.equal(r.overbook.toFixed(2), "16.00");
  assert.equal(r.allocated.add(r.bench).toFixed(2), "144.00");
});

test("splitAvailableCapacity: nothing allocated → all bench", () => {
  const r = splitAvailableCapacity(d(160), d(0));
  assert.equal(r.allocated.toFixed(2), "0.00");
  assert.equal(r.bench.toFixed(2), "160.00");
  assert.equal(r.overbook.toFixed(2), "0.00");
});

test("splitAvailableCapacity: zero available (fully off) → all overbook, no bench", () => {
  const r = splitAvailableCapacity(d(0), d(40));
  assert.equal(r.allocated.toFixed(2), "0.00");
  assert.equal(r.bench.toFixed(2), "0.00");
  assert.equal(r.overbook.toFixed(2), "40.00");
});

test("end-to-end: assumed full month = planned_full × (actual/planned_to_date)", () => {
  // Mid-month: planned 100h so far, worked 96h → ratio 0.96.
  // Full-month plan 120h → assumed ~115.2h.
  const ratio = realizationRatio(d(96), d(100));
  assert.equal(projectAssumed(d(120), ratio)!.toFixed(2), "115.20");
});
