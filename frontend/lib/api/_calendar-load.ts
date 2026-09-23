/** Pure helpers behind the calendar route's load math. Extracted so
 * they're testable without spinning up the route — the route is
 * pages of SQL + cell construction that would dominate any test
 * harness; the bits that actually go wrong (per-project collapse,
 * unmapped-awork-project isolation, max-not-sum within a project,
 * the past/future split) live here.
 *
 * Two regimes, chosen per cell by whether the day is already over:
 *
 *   • future (and today) — PLANNED load only. What was scheduled for
 *     the person: manual `assignment.allocation_pct` + awork Planner
 *     bookings. > 1.0 means "overbooked": more work was planned than
 *     fits in a day.
 *   • past — ACTUAL load only. awork tracked hours ÷ 8h. > 1.0 means
 *     "overtime": the person clocked more than a day.
 *
 * Mixing the two (the previous Σ max(manual, planned, tracked) form)
 * flagged normal days as overbooked whenever the plan and the actual
 * landed on different projects — "planned on A, worked on B" read as
 * plan PLUS actual. Keeping them apart makes the red cell mean one
 * thing on either side of today.
 *
 * Capacity is a fixed 8h day for every employee. `allocation_pct` is a
 * fraction of full-time (1.0 = 8h), awork hours are literal hours, so
 * the two share the 8h denominator. Deliberately NOT scaled by weekly
 * FTE: part-timers work full 8h days on fewer days, so dividing an 8h
 * booking by 0.8 painted every one of their working days red. */

export type ProjectLoadBucket = {
  /** Manual `assignment.allocation_pct` for this project, on this day,
   * for this employee. Already filtered to source='manual' upstream. */
  manual: number;
  /** awork Planner hours scheduled on this project on this day. */
  planned_h: number;
  /** awork tracked hours actually logged on this project on this day. */
  awork_tracked_h: number;
};

export type LoadKind = "planned" | "actual";

/** Hours in one working day. Shared denominator for allocation_pct
 * (1.0 = one full day) and awork hours. */
export const DAY_HOURS = 8;

/** Compose a stable bucket key for a (project, awork_project) pair.
 * Dante project_id when present (so a manual assignment and a linked
 * awork booking collapse into one bucket); a synthetic
 * `awork:<awork_project_id>` otherwise (so unlinked awork projects
 * stay isolated and don't accidentally merge with each other or with
 * unrelated manual rows). */
export function bucketKey(
  dante_project_id: number | null | undefined,
  awork_project_id?: string | null,
): string {
  return dante_project_id !== null && dante_project_id !== undefined
    ? `dante:${dante_project_id}`
    : `awork:${awork_project_id ?? "untagged"}`;
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
 *   actual:  Σ over projects of awork_tracked_h / 8. Plain hours
 *            worked; the project split doesn't change the total.
 *
 * `planned_hours` (the tooltip's "Planned: Xh [awork]") is reported in
 * both regimes — on a past day it's still useful to see what HAD been
 * scheduled next to what was clocked. */
export function computeLoad(
  buckets: Iterable<ProjectLoadBucket>,
  kind: LoadKind,
): { load: number; planned_hours: number } {
  let load = 0;
  let planned_h_sum = 0;
  for (const b of buckets) {
    planned_h_sum += b.planned_h;
    if (kind === "planned") {
      load += Math.max(b.manual, b.planned_h / DAY_HOURS);
    } else {
      load += b.awork_tracked_h / DAY_HOURS;
    }
  }
  return { load, planned_hours: Math.round(planned_h_sum * 10) / 10 };
}
