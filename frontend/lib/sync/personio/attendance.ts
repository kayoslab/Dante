/** Personio v2 /attendance-periods → attendance rows.
 *
 * v2 models a day as multiple period objects (`type` WORK | BREAK), each
 * with its own start/end datetime and UUID id. We persist one row per
 * WORK period (breaks are carved out between work spans, so summing WORK
 * durations already yields net worked time — no break subtraction). Every
 * downstream consumer does `SUM(duration_minutes) GROUP BY employee_id,
 * work_date[, project_id]`, so multiple WORK rows per day are transparent.
 */
import type { Client } from "pg";

import { attendance } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";
import { log } from "@/lib/logger";

import type { PersonioClient } from "./client";

const ATTENDANCE_COLUMNS = [
  "attendance_id",
  "employee_id",
  "work_date",
  "start_time",
  "end_time",
  "break_minutes",
  "duration_minutes",
  "project_id",
  "status",
  "updated_at",
] as const;

/** Result of an attendance pull: rows upserted + whether the run was a
 * `full` window backfill or an `incremental` (updated_at.gte) delta. */
export type AttendancePullResult = { count: number; mode: "full" | "incremental" };

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

/** Flatten one v2 attendance period into an `attendance` row, or return
 * null to skip it. Skips: BREAK periods (carved out — never stored),
 * open periods (no end yet — re-appear once closed via delta), and any
 * period missing an id / person / attribution_date / parseable span.
 *
 * `start`/`end` are RFC3339 without a timezone; both share the tenant
 * offset, so their difference is timezone-invariant. `work_date` is
 * `attribution_date` (the day the hours count toward — correct even for
 * overnight spans, unlike the start date). */
export function flattenAttendancePeriod(
  item: unknown,
): Record<string, unknown> | null {
  const p = item as V2AttendancePeriod;
  if (p.type !== "WORK") return null;

  const id = p.id;
  const person_id = p.person?.id;
  const work_date = p.attribution_date;
  const start = p.start?.date_time;
  const end = p.end?.date_time;
  if (!id || !person_id || !work_date || !start || !end) return null;

  const employee_id = Number(person_id);
  if (!Number.isInteger(employee_id)) return null;

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const duration_minutes = Math.round((endMs - startMs) / 60000);
  if (duration_minutes <= 0) return null;

  return {
    attendance_id: id,
    employee_id,
    work_date,
    start_time: start,
    end_time: end,
    break_minutes: null,
    duration_minutes,
    project_id: p.project?.id ?? null,
    status: p.approval?.status ?? null,
    updated_at: p.updated_at ? new Date(p.updated_at) : null,
  };
}

/** High-water mark for the attendance delta: the newest v2 `updated_at`
 * already stored, formatted for the v2 `updated_at.gte` filter. Null when
 * the table is empty (post-migration / first run) → the caller does a
 * full-window backfill instead.
 *
 * Format matters: v2 `updated_at.gte` accepts ONLY a **naive** datetime
 * `YYYY-MM-DDTHH:MM:SS` — a trailing `Z`/`+00:00` or fractional seconds
 * are rejected with HTTP 400 (verified against the live tenant). So we
 * take the UTC wall-clock and drop the milliseconds + zone. Truncating
 * ms floors the value, and the filter is inclusive (`gte`), so the
 * boundary row is re-pulled rather than skipped — safe with the
 * idempotent upsert. (Personio reads the naive value as tenant-local;
 * for this Europe/Berlin tenant that offset is ≥ +1, i.e. an earlier
 * absolute instant than the UTC watermark, so it can only re-pull, never
 * miss.) */
async function attendanceMaxUpdatedAt(conn: Client): Promise<string | null> {
  const r = await conn.query<{ max: Date | null }>(
    `SELECT MAX(updated_at) AS max FROM attendance`,
  );
  const max = r.rows[0]?.max ?? null;
  return max ? new Date(max).toISOString().slice(0, 19) : null;
}

/** Sync Personio v2 attendance.
 *
 * Default (delta): pull only periods with `updated_at >= high-water mark`
 * — catches edits to any day, not just those in a fixed window. Falls
 * back to a full `attribution_date` window pull when there's no watermark
 * yet (empty table) or when Personio rejects the delta filter (logged).
 * `full = true` forces the window backfill (manual
 * "Sync" button / reconciliation). Deletions aren't detected by delta —
 * same gap as the previous windowed sync; a full run re-mirrors the
 * window. */
export async function syncAttendances(
  conn: Client,
  client: PersonioClient,
  sync_run_id: number,
  window: { start_date: string; end_date: string },
  full = false,
): Promise<AttendancePullResult> {
  const db = syncDrizzle(conn);

  const fullWindow = (): Promise<unknown[]> =>
    client.listAttendancePeriods({
      attribution_from: window.start_date,
      attribution_to: window.end_date,
    });

  let items: unknown[];
  let mode: "full" | "incremental" = "full";
  if (full) {
    items = await fullWindow();
  } else {
    const updated_since = await attendanceMaxUpdatedAt(conn);
    if (updated_since) {
      try {
        items = await client.listAttendancePeriods({ updated_since });
        mode = "incremental";
      } catch (e) {
        log.warn("personio_attendance_delta_fallback", {
          issue: e instanceof Error ? e.message : String(e),
        });
        items = await fullWindow();
      }
    } else {
      items = await fullWindow();
    }
  }

  const set = excludedSet([
    ...ATTENDANCE_COLUMNS.filter((c) => c !== "attendance_id"),
    "last_seen_sync_run_id",
  ] as const);

  let count = 0;
  for (const item of items) {
    const row = flattenAttendancePeriod(item);
    if (!row) continue;
    await db
      .insert(attendance)
      .values({
        ...row,
        last_seen_sync_run_id: sync_run_id,
      } as typeof attendance.$inferInsert)
      .onConflictDoUpdate({
        target: attendance.attendance_id,
        set,
      });
    count += 1;
  }
  return { count, mode };
}
