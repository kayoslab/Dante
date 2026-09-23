import { test } from "node:test";
import { strict as assert } from "node:assert";

import { bucketKey, computeLoad, loadKindFor } from "./_calendar-load";

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

test("loadKindFor: yesterday is actual, today and tomorrow are planned", () => {
  assert.equal(loadKindFor("2026-09-22", "2026-09-23"), "actual");
  assert.equal(loadKindFor("2026-09-23", "2026-09-23"), "planned");
  assert.equal(loadKindFor("2026-09-24", "2026-09-23"), "planned");
});

test("computeLoad: empty cell → 0 / 0 in both regimes", () => {
  for (const kind of ["planned", "actual"] as const) {
    const { load, planned_hours } = computeLoad([], kind);
    assert.equal(load, 0);
    assert.equal(planned_hours, 0);
  }
});

// ---------------------------------------------------------------- planned

test("planned: pure manual day is 1.0 with no planned hours", () => {
  const { load, planned_hours } = computeLoad(
    [{ manual: 1.0, planned_h: 0, awork_tracked_h: 0 }],
    "planned",
  );
  assert.equal(load, 1.0);
  assert.equal(planned_hours, 0);
});

test("planned: 8h planned with no manual = 1.0 load", () => {
  const { load, planned_hours } = computeLoad(
    [{ manual: 0, planned_h: 8, awork_tracked_h: 0 }],
    "planned",
  );
  assert.equal(load, 1.0);
  assert.equal(planned_hours, 8);
});

test("planned: manual + planned on SAME project collapse via max", () => {
  // PM manually allocated 1.00 to Project X AND the same project has
  // an 8h awork booking on this day. Same work — stays 1.00, not 2.00.
  const { load } = computeLoad(
    [{ manual: 1.0, planned_h: 8, awork_tracked_h: 0 }],
    "planned",
  );
  assert.equal(load, 1.0);
});

test("planned: distinct projects sum across (real overbook)", () => {
  // 0.28 on one project (long-running booking, ~2.22h/day) + a separate
  // booking that schedules 8h on this day. Two distinct projects, so
  // they add: 0.28 + 1.0 = 1.28.
  const { load, planned_hours } = computeLoad(
    [
      { manual: 0.28, planned_h: 2.22, awork_tracked_h: 0 },
      { manual: 0, planned_h: 8, awork_tracked_h: 0 },
    ],
    "planned",
  );
  assert.equal(Math.round(load * 100) / 100, 1.28);
  assert.equal(planned_hours, 10.2);
});

test("planned: overlapping bookings on same project sum within planned_h", () => {
  // Two 8h bookings on the same day land in the same bucket before
  // computeLoad runs — the aggregator adds them. 16h / 8 → 2.0. This
  // IS overbooking in the planning, surface it.
  const { load } = computeLoad(
    [{ manual: 0, planned_h: 16, awork_tracked_h: 0 }],
    "planned",
  );
  assert.equal(load, 2.0);
});

test("planned: manual on Project A + awork on Project B = sum", () => {
  const { load } = computeLoad(
    [
      { manual: 1.0, planned_h: 0, awork_tracked_h: 0 },
      { manual: 0, planned_h: 4, awork_tracked_h: 0 },
    ],
    "planned",
  );
  assert.equal(load, 1.5);
});

test("planned: tracked hours are ignored entirely", () => {
  // Today / future: even if someone already clocked 10h (today, or a
  // stray entry), the plan is the signal. 8h planned → 1.0, not 1.25.
  const { load } = computeLoad(
    [
      { manual: 0, planned_h: 8, awork_tracked_h: 10 },
      { manual: 0, planned_h: 0, awork_tracked_h: 3 },
    ],
    "planned",
  );
  assert.equal(load, 1.0);
});

// ----------------------------------------------------------------- actual

test("actual: 8h tracked = 1.0, plan is ignored", () => {
  // Past day: 8h tracked on a project that had a 16h double-booking.
  // The plan is history — what matters is what was worked.
  const { load, planned_hours } = computeLoad(
    [{ manual: 1.0, planned_h: 16, awork_tracked_h: 8 }],
    "actual",
  );
  assert.equal(load, 1.0);
  // Planned hours still reported for the tooltip.
  assert.equal(planned_hours, 16);
});

test("actual: planned on A, worked on B is NOT overtime", () => {
  // The case that produced most of the false reds: 8h scheduled on
  // Project A, the 8h actually logged on Project B. Old formula summed
  // them to 2.0; actual-only reads 1.0.
  const { load } = computeLoad(
    [
      { manual: 0, planned_h: 8, awork_tracked_h: 0 },
      { manual: 0, planned_h: 0, awork_tracked_h: 8 },
    ],
    "actual",
  );
  assert.equal(load, 1.0);
});

test("actual: tracked hours sum across projects, 10h → 1.25 overtime", () => {
  const { load } = computeLoad(
    [
      { manual: 0, planned_h: 0, awork_tracked_h: 6 },
      { manual: 0, planned_h: 0, awork_tracked_h: 4 },
    ],
    "actual",
  );
  assert.equal(load, 1.25);
});

test("actual: unlinked awork project bucket counts like any other", () => {
  // Time logged on an awork project with no Dante link lands in its own
  // `awork:<id>` bucket. It's still hours worked.
  const { load } = computeLoad(
    [
      { manual: 0, planned_h: 0, awork_tracked_h: 4 },
      { manual: 0, planned_h: 0, awork_tracked_h: 2 },
    ],
    "actual",
  );
  assert.equal(load, 0.75);
});

test("actual: planned-but-not-worked day is 0", () => {
  // Past day with a plan and no time logged (sick without absence
  // record, forgot to track, …). Nothing worked → empty cell; the
  // planned hours remain in the tooltip.
  const { load, planned_hours } = computeLoad(
    [{ manual: 1.0, planned_h: 8, awork_tracked_h: 0 }],
    "actual",
  );
  assert.equal(load, 0);
  assert.equal(planned_hours, 8);
});
