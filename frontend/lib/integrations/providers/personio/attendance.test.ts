import { test } from "node:test";
import { strict as assert } from "node:assert";

import { flattenAttendancePeriod } from "./attendance";

// A fully-populated v2 WORK period. Individual tests clone + tweak this.
function workPeriod(): Record<string, unknown> {
  return {
    id: "8f3c1e2a-0000-4a1b-9c00-000000000001",
    type: "WORK",
    person: { id: "42" },
    project: { id: "82173" },
    start: { date_time: "2026-07-14T09:00:00" },
    end: { date_time: "2026-07-14T17:30:00" },
    attribution_date: "2026-07-14",
    comment: "ignored",
    approval: { status: "CONFIRMED" },
    updated_at: "2026-07-14T18:00:00Z",
  };
}

test("flattenAttendancePeriod: maps a WORK period to a row", () => {
  const row = flattenAttendancePeriod(workPeriod());
  assert.deepEqual(row, {
    external_id: "8f3c1e2a-0000-4a1b-9c00-000000000001",
    external_person_id: "42",
    external_project_id: "82173",
    external_task_id: null,
    work_date: "2026-07-14",
    start_at: new Date("2026-07-14T09:00:00"),
    end_at: new Date("2026-07-14T17:30:00"),
    // 09:00 → 17:30 = 510 minutes; breaks are separate BREAK periods,
    // so NO subtraction happens here.
    duration_minutes: 510,
    is_billable: null,
    is_billed: null,
    status: "CONFIRMED",
    note: "ignored",
    type_of_work: null,
    // Raw wall-clock strings survive untouched next to the parsed dates.
    extra: { start_raw: "2026-07-14T09:00:00", end_raw: "2026-07-14T17:30:00" },
    source_updated_at: new Date("2026-07-14T18:00:00Z"),
  });
});

test("flattenAttendancePeriod: skips BREAK periods", () => {
  assert.equal(
    flattenAttendancePeriod({ ...workPeriod(), type: "BREAK" }),
    null,
  );
});

test("flattenAttendancePeriod: skips unknown / missing type", () => {
  assert.equal(flattenAttendancePeriod({ ...workPeriod(), type: "OTHER" }), null);
  const { type: _drop, ...noType } = workPeriod();
  assert.equal(flattenAttendancePeriod(noType), null);
});

test("flattenAttendancePeriod: skips an open period (no end yet)", () => {
  const { end: _drop, ...open } = workPeriod();
  assert.equal(flattenAttendancePeriod(open), null);
  assert.equal(flattenAttendancePeriod({ ...workPeriod(), end: null }), null);
});

test("flattenAttendancePeriod: skips periods missing id / person / date", () => {
  const { id: _noId, ...noId } = workPeriod();
  assert.equal(flattenAttendancePeriod(noId), null);
  assert.equal(flattenAttendancePeriod({ ...workPeriod(), person: null }), null);
  const { attribution_date: _noDate, ...noDate } = workPeriod();
  assert.equal(flattenAttendancePeriod(noDate), null);
});

test("flattenAttendancePeriod: skips a non-integer person id", () => {
  assert.equal(
    flattenAttendancePeriod({ ...workPeriod(), person: { id: "abc" } }),
    null,
  );
});

test("flattenAttendancePeriod: skips an unparseable span", () => {
  assert.equal(
    flattenAttendancePeriod({
      ...workPeriod(),
      start: { date_time: "not-a-date" },
    }),
    null,
  );
});

test("flattenAttendancePeriod: skips a zero / negative duration", () => {
  const zero = {
    ...workPeriod(),
    start: { date_time: "2026-07-14T09:00:00" },
    end: { date_time: "2026-07-14T09:00:00" },
  };
  assert.equal(flattenAttendancePeriod(zero), null);
  const negative = {
    ...workPeriod(),
    start: { date_time: "2026-07-14T17:00:00" },
    end: { date_time: "2026-07-14T09:00:00" },
  };
  assert.equal(flattenAttendancePeriod(negative), null);
});

test("flattenAttendancePeriod: overnight span uses attribution_date, not the start date", () => {
  const overnight = {
    ...workPeriod(),
    start: { date_time: "2026-07-14T22:00:00" },
    end: { date_time: "2026-07-15T02:00:00" },
    // Personio attributes the shift to the day it counts toward.
    attribution_date: "2026-07-14",
  };
  const row = flattenAttendancePeriod(overnight);
  assert.equal(row?.work_date, "2026-07-14");
  assert.equal(row?.duration_minutes, 240);
});

test("flattenAttendancePeriod: nullable fields default to null", () => {
  const sparse = {
    id: "u",
    type: "WORK",
    person: { id: "7" },
    start: { date_time: "2026-07-14T09:00:00" },
    end: { date_time: "2026-07-14T10:00:00" },
    attribution_date: "2026-07-14",
    // no project, no approval, no updated_at
  };
  const row = flattenAttendancePeriod(sparse);
  assert.equal(row?.external_project_id, null);
  assert.equal(row?.status, null);
  assert.equal(row?.source_updated_at, null);
  assert.equal(row?.duration_minutes, 60);
});

test("flattenAttendancePeriod: rounds sub-minute spans to the nearest minute", () => {
  const row = flattenAttendancePeriod({
    ...workPeriod(),
    start: { date_time: "2026-07-14T09:00:00" },
    end: { date_time: "2026-07-14T09:00:40" },
  });
  // 40s rounds to 1 minute (and is > 0, so it's kept).
  assert.equal(row?.duration_minutes, 1);
});
