import { test } from "node:test";
import { strict as assert } from "node:assert";

import { bucketKey, computeLoad } from "./_calendar-load";

test("bucketKey: dante project_id wins when present", () => {
  assert.equal(bucketKey(1194, "abc-uuid"), "dante:1194");
  assert.equal(bucketKey(1194, null), "dante:1194");
});

test("bucketKey: falls back to awork_project_id when no dante link", () => {
  assert.equal(bucketKey(null, "abc-uuid"), "awork:abc-uuid");
  assert.equal(bucketKey(undefined, "abc-uuid"), "awork:abc-uuid");
});

test("bucketKey: untagged sentinel when both are missing", () => {
  assert.equal(bucketKey(null, null), "awork:untagged");
  assert.equal(bucketKey(null, undefined), "awork:untagged");
});

test("computeLoad: empty cell → 0 / 0", () => {
  const { load, planned_hours } = computeLoad([]);
  assert.equal(load, 0);
  assert.equal(planned_hours, 0);
});

test("computeLoad: pure manual day is 1.0 with no planned hours", () => {
  const { load, planned_hours } = computeLoad([
    { manual: 1.0, planned_h: 0, awork_tracked_h: 0 },
  ]);
  assert.equal(load, 1.0);
  assert.equal(planned_hours, 0);
});

test("computeLoad: 8h planned with no manual = 1.0 load", () => {
  const { load, planned_hours } = computeLoad([
    { manual: 0, planned_h: 8, awork_tracked_h: 0 },
  ]);
  assert.equal(load, 1.0);
  assert.equal(planned_hours, 8);
});

test("computeLoad: manual + planned on SAME project collapse via max", () => {
  // The bug we shipped and reverted: PM manually allocated 1.00 to
  // Project X AND the same project has an 8h awork booking on this
  // day. These are the same work — must stay at 1.00, not stack.
  const { load } = computeLoad([
    { manual: 1.0, planned_h: 8, awork_tracked_h: 0 },
  ]);
  assert.equal(load, 1.0);
});

test("computeLoad: planned + tracked on SAME project collapse via max", () => {
  // Past-day case: 8h planned AND 8h tracked on the same project.
  // Tracked is the realized version of planned — not additive.
  const { load } = computeLoad([
    { manual: 0, planned_h: 8, awork_tracked_h: 8 },
  ]);
  assert.equal(load, 1.0);
});

test("computeLoad: distinct projects sum across (real overbook)", () => {
  // Yule's tooltip case: 0.28 CAVE allocation (from a long-running
  // awork booking that distributes to ~2.22h/day) + a separate DB
  // 2079 awork booking that schedules 8h on this day. Two distinct
  // projects, so they add: 0.28 + 1.0 = 1.28 (mild overbook). When
  // we shipped the wrong "sum within bucket" logic this was 2.28.
  const { load, planned_hours } = computeLoad([
    { manual: 0.28, planned_h: 2.22, awork_tracked_h: 0 },
    { manual: 0, planned_h: 8, awork_tracked_h: 0 },
  ]);
  assert.equal(Math.round(load * 100) / 100, 1.28);
  assert.equal(planned_hours, 10.2);
});

test("computeLoad: overlapping awork bookings on same project sum within planned_h", () => {
  // Lucas Micoud's case: two 8h bookings on the same day land in the
  // same bucket (same project) before computeLoad runs — the
  // upstream aggregator just adds them. We then divide by 8 → 2.0.
  // This IS overbooking in the planning, surface it.
  const { load } = computeLoad([
    { manual: 0, planned_h: 16, awork_tracked_h: 0 },
  ]);
  assert.equal(load, 2.0);
});

test("computeLoad: manual on Project A + awork on Project B = sum", () => {
  // Tim Harder on ITZ Bund (manual 1.0) + 4h scheduled on a totally
  // different awork project = 1.5 — real over-allocation.
  const { load } = computeLoad([
    { manual: 1.0, planned_h: 0, awork_tracked_h: 0 },
    { manual: 0, planned_h: 4, awork_tracked_h: 0 },
  ]);
  assert.equal(load, 1.5);
});

test("computeLoad: tracked overtime surfaces as overbook", () => {
  // Past day: 10h actually clocked in awork. Load = 1.25.
  const { load } = computeLoad([
    { manual: 0, planned_h: 0, awork_tracked_h: 10 },
  ]);
  assert.equal(load, 1.25);
});

test("computeLoad: planned + tracked on same project takes the larger", () => {
  // Tracked exceeds planned (worked harder than scheduled).
  const { load } = computeLoad([
    { manual: 0, planned_h: 4, awork_tracked_h: 8 },
  ]);
  assert.equal(load, 1.0);
});
