/** Pure helpers behind the calendar route's load math. Extracted so
 * they're testable without spinning up the route — the route is
 * pages of SQL + cell construction that would dominate any test
 * harness; the bits that actually go wrong (per-project collapse,
 * unmapped-awork-project isolation, max-not-sum within a project)
 * live here. */

export type ProjectLoadBucket = {
  /** Manual `assignment.allocation_pct` for this project, on this day,
   * for this employee. Already filtered to source='manual' upstream. */
  manual: number;
  /** awork Planner hours scheduled on this project on this day, as
   * a fraction of an 8h day. */
  planned_h: number;
  /** awork tracked hours actually logged on this project on this day. */
  awork_tracked_h: number;
};

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

/** Cell load = Σ over projects of max(manual, planned/8, awork_tracked/8).
 *
 * Two views of the same project's day (manual contract + awork booking)
 * collapse via `max` — they describe the same work, not two stacked
 * jobs. Across projects we sum, because those ARE different work. */
export function computeLoad(
  buckets: Iterable<ProjectLoadBucket>,
): { load: number; planned_hours: number } {
  let load = 0;
  let planned_h_sum = 0;
  for (const b of buckets) {
    load += Math.max(b.manual, b.planned_h / 8, b.awork_tracked_h / 8);
    planned_h_sum += b.planned_h;
  }
  return { load, planned_hours: Math.round(planned_h_sum * 10) / 10 };
}
