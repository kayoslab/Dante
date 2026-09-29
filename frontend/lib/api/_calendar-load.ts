/** Pure helpers behind the calendar route's load math. Extracted so
 * they're testable without spinning up the route — the route is
 * pages of SQL + cell construction that would dominate any test
 * harness; the bits that actually go wrong (per-project collapse,
 * unmapped-external-project isolation, max-not-sum within a project,
 * the past/future split) live here.
 *
 * Two regimes, chosen per cell by whether the day is already over:
 *
 *   • future (and today) — PLANNED load only. What was scheduled for
 *     the person: manual `assignment.allocation_pct` + planner
 *     bookings. > 1.0 means "overbooked": more work was planned than
 *     fits in a day.
 *   • past — ACTUAL load only. delivery-tool tracked hours ÷ 8h; when nothing
 *     was tracked there that day, HRIS attendance ÷ 8h instead.
 *     > 1.0 means "overtime": the person clocked more than a day.
 *
 * Mixing the two (the previous Σ max(manual, planned, tracked) form)
 * flagged normal days as overbooked whenever the plan and the actual
 * landed on different projects — "planned on A, worked on B" read as
 * plan PLUS actual. Keeping them apart makes the red cell mean one
 * thing on either side of today.
 *
 * Capacity is a fixed 8h day for every employee. `allocation_pct` is a
 * fraction of full-time (1.0 = 8h), tracked hours are literal hours, so
 * the two share the 8h denominator. Deliberately NOT scaled by weekly
 * FTE: part-timers work full 8h days on fewer days, so dividing an 8h
 * booking by 0.8 painted every one of their working days red. */

export type ProjectLoadBucket = {
  /** Manual `assignment.allocation_pct` for this project, on this day,
   * for this employee. Already filtered to source='manual' upstream. */
  manual: number;
  /** Planner hours scheduled on this project on this day. */
  planned_h: number;
  /** Delivery-tool tracked hours actually logged on this project on this
   * day (every time-entry integration except the HRIS). */
  delivery_tracked_h: number;
};

export type LoadKind = "planned" | "actual";

/** Where an "actual" load came from. Delivery-tool time is preferred
 * (project-level detail); HRIS attendance is the fallback for people/days
 * with no delivery-tool entries at all. Null on planned cells and on empty
 * actual cells. */
export type ActualSource = "delivery" | "attendance";

/** Hours in one working day. Shared denominator for allocation_pct
 * (1.0 = one full day) and tracked hours. */
export const DAY_HOURS = 8;

/** Compose a stable bucket key for a (project, external project) pair.
 * Dante project_id when present (so a manual assignment and a linked
 * booking collapse into one bucket); a synthetic
 * `ext:<external_project_id>` otherwise (so unlinked external projects
 * stay isolated and don't accidentally merge with each other or with
 * unrelated manual rows). */
export function bucketKey(
  dante_project_id: number | null | undefined,
  external_project_id?: string | null,
): string {
  return dante_project_id !== null && dante_project_id !== undefined
    ? `dante:${dante_project_id}`
    : `ext:${external_project_id ?? "untagged"}`;
}

/** Which regime a cell falls into. Today counts as future: the day
 * isn't over, so tracked time would be a partial picture while the
 * plan is still the operative statement. */
export function loadKindFor(iso_day: string, today_iso: string): LoadKind {
  return iso_day < today_iso ? "actual" : "planned";
}

/** Cell load for one regime.
 *
 *   planned: Σ over projects of max(manual, planned_h / 8).
 *            Two views of the same project's day (manual contract +
 *            awork booking) collapse via `max` — they describe the
 *            same work, not two stacked jobs. Across projects we sum,
 *            because those ARE different work.
 *   actual:  Σ over projects of delivery_tracked_h / 8. Plain hours
 *            worked; the project split doesn't change the total.
 *            If that sum is 0 and `attendance_h` > 0, HRIS attendance
 *            stands in — the person worked, they just don't log in the
 *            delivery tool (or forgot that day). Never blended: once any
 *            delivery-tool time exists, attendance stays a corner
 *            number so double-tracking can't inflate the load.
 *
 * `planned_hours` (the tooltip's "Planned: Xh") is reported in
 * both regimes — on a past day it's still useful to see what HAD been
 * scheduled next to what was clocked. */
export function computeLoad(
  buckets: Iterable<ProjectLoadBucket>,
  kind: LoadKind,
  attendance_h = 0,
): { load: number; planned_hours: number; actual_source: ActualSource | null } {
  let load = 0;
  let planned_h_sum = 0;
  for (const b of buckets) {
    planned_h_sum += b.planned_h;
    if (kind === "planned") {
      load += Math.max(b.manual, b.planned_h / DAY_HOURS);
    } else {
      load += b.delivery_tracked_h / DAY_HOURS;
    }
  }
  let actual_source: ActualSource | null = null;
  if (kind === "actual") {
    if (load > 0) {
      actual_source = "delivery";
    } else if (attendance_h > 0) {
      load = attendance_h / DAY_HOURS;
      actual_source = "attendance";
    }
  }
  return {
    load,
    planned_hours: Math.round(planned_h_sum * 10) / 10,
    actual_source,
  };
}
