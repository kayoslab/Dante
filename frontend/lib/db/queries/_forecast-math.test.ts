import { test } from "node:test";
import { strict as assert } from "node:assert";
import Decimal from "decimal.js";

import {
  plannedHours,
  realizationRatio,
  projectAssumed,
  capacitySplit,
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

test("capacitySplit: under-booked → on-project = allocation, rest bench, no over", () => {
  // 160h capacity, 16h vacation → 144h available; 120h allocated.
  const r = capacitySplit(d(160), d(16), d(120));
  assert.equal(r.on_project.toFixed(2), "120.00");
  assert.equal(r.bench.toFixed(2), "24.00");
  assert.equal(r.overbook.toFixed(2), "0.00");
  // on-project + bench + vacation = capacity
  assert.equal(r.on_project.add(r.bench).add(d(16)).toFixed(2), "160.00");
});

test("capacitySplit: full allocation + vacation → over 0 (vacation is not over)", () => {
  // 160h capacity, allocated a full 160h, 16h vacation. The 16h that lands on
  // vacation isn't deliverable, but that's PLANNED — not overbooked.
  const r = capacitySplit(d(160), d(16), d(160));
  assert.equal(r.on_project.toFixed(2), "144.00"); // capped at available
  assert.equal(r.bench.toFixed(2), "0.00");
  assert.equal(r.overbook.toFixed(2), "0.00"); // allocation == capacity → no over
  assert.equal(r.on_project.add(r.bench).add(d(16)).toFixed(2), "160.00");
});

test("capacitySplit: genuine over-allocation (>capacity) → overbook flagged", () => {
  // 160h capacity, no vacation, planned 192h (120%) → over 32h.
  const r = capacitySplit(d(160), d(0), d(192));
  assert.equal(r.on_project.toFixed(2), "160.00");
  assert.equal(r.bench.toFixed(2), "0.00");
  assert.equal(r.overbook.toFixed(2), "32.00");
});

test("capacitySplit: over-allocation with vacation → over vs capacity, not available", () => {
  // 160h capacity, 16h vacation, planned 192h → over = 192 − 160 = 32 (NOT 48).
  const r = capacitySplit(d(160), d(16), d(192));
  assert.equal(r.on_project.toFixed(2), "144.00");
  assert.equal(r.overbook.toFixed(2), "32.00");
});

test("capacitySplit: nothing allocated → all bench", () => {
  const r = capacitySplit(d(160), d(0), d(0));
  assert.equal(r.on_project.toFixed(2), "0.00");
  assert.equal(r.bench.toFixed(2), "160.00");
  assert.equal(r.overbook.toFixed(2), "0.00");
});

test("end-to-end: assumed full month = planned_full × (actual/planned_to_date)", () => {
  // Mid-month: planned 100h so far, worked 96h → ratio 0.96.
  // Full-month plan 120h → assumed ~115.2h.
  const ratio = realizationRatio(d(96), d(100));
  assert.equal(projectAssumed(d(120), ratio)!.toFixed(2), "115.20");
});
