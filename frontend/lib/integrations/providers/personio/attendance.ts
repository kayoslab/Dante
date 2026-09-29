/** Personio v2 /attendance-periods → canonical time entries.
 *
 * v2 models a day as multiple period objects (`type` WORK | BREAK), each
 * with its own start/end datetime and UUID id. One canonical entry per
 * WORK period; breaks are carved out between work spans, so summing WORK
 * durations already yields net worked time — no break subtraction.
 */
import type { CanonicalTimeEntry } from "@/lib/integrations/core/types";

type V2AttendancePeriod = {
  id?: string;
  type?: string;
  person?: { id?: string } | null;
  project?: { id?: string } | null;
  start?: { date_time?: string } | null;
  end?: { date_time?: string } | null;
  attribution_date?: string;
  comment?: string | null;
  approval?: { status?: string } | null;
  updated_at?: string;
};

/** Flatten one v2 attendance period, or return null to skip it. Skips:
 * BREAK periods (never stored), open periods (no end yet — re-appear once
 * closed via delta), and any period missing an id / person /
 * attribution_date / parseable span.
 *
 * `start`/`end` are RFC3339 without a timezone; both share the tenant
 * offset, so their difference is timezone-invariant. `work_date` is
 * `attribution_date` (the day the hours count toward — correct even for
 * overnight spans). The raw wall-clock strings are kept in `extra` so
 * nothing is lost to timezone interpretation. */
export function flattenAttendancePeriod(item: unknown): CanonicalTimeEntry | null {
  const p = item as V2AttendancePeriod;
  if (p.type !== "WORK") return null;

  const id = p.id;
  const person_id = p.person?.id;
  const work_date = p.attribution_date;
  const start = p.start?.date_time;
  const end = p.end?.date_time;
  if (!id || !person_id || !work_date || !start || !end) return null;
  if (!/^\d+$/.test(person_id)) return null;

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const duration_minutes = Math.round((endMs - startMs) / 60000);
  if (duration_minutes <= 0) return null;

  return {
    external_id: id,
    external_person_id: person_id,
    external_project_id: p.project?.id ?? null,
    external_task_id: null,
    work_date,
    start_at: new Date(startMs),
    end_at: new Date(endMs),
    duration_minutes,
    is_billable: null,
    is_billed: null,
    status: p.approval?.status ?? null,
    note: p.comment ?? null,
    type_of_work: null,
    extra: { start_raw: start, end_raw: end },
    source_updated_at: p.updated_at ? new Date(p.updated_at) : null,
  };
}

/** Format a high-water mark for the v2 `updated_at.gte` filter, which
 * accepts ONLY a naive `YYYY-MM-DDTHH:MM:SS` (a trailing `Z` / offset or
 * fractional seconds are rejected with HTTP 400). Truncating floors the
 * value and the filter is inclusive, so the boundary row is re-pulled
 * rather than skipped — safe with the idempotent upsert. */
export function formatUpdatedSince(d: Date): string {
  return d.toISOString().slice(0, 19);
}
