/** Rollups from canonical tables into Dante's own planning tables.
 *
 * Both run after links are resolved, for every integration at once —
 * the joins go through `external_link` per row's own integration, so a
 * second planner or time-tracking tool needs no changes here.
 *
 *   - planned bookings → `assignment` rows with source = 'awork-planning'
 *     (the source tag is kept for compatibility with existing readers;
 *     it means "synthesised from a planner", whichever one);
 *   - time entries → `freelancer_time_entry` per (assignment, month).
 */
import type { Client } from "pg";

import { germanFederalHolidays } from "@/lib/db/_de-holidays";

/** Source tag on synthesised assignment rows. Readers filter on it. */
export const PLANNING_ASSIGNMENT_SOURCE = "awork-planning";

// Holiday-aware working days for the planner rollup. German federal
// holidays only (bookings carry no office/state); cached per year range.
const plannerHolidayCache = new Map<string, Map<string, string>>();
function plannerWorkdays(start: string, end: string): string[] {
  const yKey = `${start.slice(0, 4)}-${end.slice(0, 4)}`;
  let holidays = plannerHolidayCache.get(yKey);
  if (holidays === undefined) {
    holidays = germanFederalHolidays(Number(start.slice(0, 4)), Number(end.slice(0, 4)));
    plannerHolidayCache.set(yKey, holidays);
  }
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (cur <= stop) {
    const iso = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(iso)) out.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export type PlanningRollupResult = {
  deleted_previous: number;
  inserted: number;
  skipped_unlinked_user: number;
  skipped_unlinked_project: number;
};

/** Roll `planned_booking` rows up into `assignment` rows so the home
 * dashboard, project economics and the calendar's allocation signal all
 * have something to work with. Wipes the previous synthesised rows and
 * re-inserts from scratch — the planner is the source of truth. Manual
 * rows are untouched.
 *
 * Bookings are bucketed per (person, project, MONTH): a one-span rollup
 * would smear lumpy plans evenly across their whole range. Allocation =
 * seconds ÷ (working days in the bucket span × 8h), capped at 1.5.
 * Bookings whose person or project is not linked are skipped; they
 * materialise once the auto-linker picks them up. */
export async function rollupPlannedBookingsToAssignments(
  conn: Client,
): Promise<PlanningRollupResult> {
  const deleted = await conn.query(`DELETE FROM assignment WHERE source = $1`, [
    PLANNING_ASSIGNMENT_SOURCE,
  ]);
  const rows = await conn.query<{
    integration_slug: string;
    external_person_id: string;
    external_project_id: string;
    employee_id: number | null;
    freelancer_id: number | null;
    project_id: number | null;
    start_date: string;
    end_date: string;
    duration_seconds: string;
  }>(`
    SELECT
      b.integration_slug,
      b.external_person_id,
      b.external_project_id,
      CASE WHEN pl.dante_type = 'employee'   THEN pl.dante_id END AS employee_id,
      CASE WHEN pl.dante_type = 'freelancer' THEN pl.dante_id END AS freelancer_id,
      prl.dante_id AS project_id,
      b.start_date::text AS start_date,
      b.end_date::text   AS end_date,
      b.duration_seconds::text AS duration_seconds
    FROM planned_booking b
    LEFT JOIN external_link pl
      ON pl.integration_slug = b.integration_slug
     AND pl.entity_type = 'person'
     AND pl.external_id = b.external_person_id
    LEFT JOIN external_link prl
      ON prl.integration_slug = b.integration_slug
     AND prl.entity_type = 'project'
     AND prl.external_id = b.external_project_id
  `);

  const now = new Date();
  let inserted = 0;
  const skippedUserPairs = new Set<string>();
  const skippedProjectPairs = new Set<string>();

  type Bucket = {
    employee_id: number | null;
    freelancer_id: number | null;
    project_id: number;
    min_day: string;
    max_day: string;
    seconds: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const r of rows.rows) {
    const pairKey = `${r.integration_slug}|${r.external_person_id}|${r.external_project_id}`;
    const has_employee = r.employee_id !== null;
    const has_freelancer = r.freelancer_id !== null;
    if (!has_employee && !has_freelancer) {
      skippedUserPairs.add(pairKey);
      continue;
    }
    if (r.project_id === null) {
      skippedProjectPairs.add(pairKey);
      continue;
    }
    const days = plannerWorkdays(r.start_date, r.end_date);
    const spreadDays = days.length > 0 ? days : [r.start_date];
    const perDay = Number(r.duration_seconds) / spreadDays.length;
    for (const day of spreadDays) {
      const month = day.slice(0, 7);
      const key = `${has_employee ? "e" + r.employee_id : "f" + r.freelancer_id}|${r.project_id}|${month}`;
      const b = buckets.get(key);
      if (b === undefined) {
        buckets.set(key, {
          employee_id: has_employee ? r.employee_id : null,
          freelancer_id: has_employee ? null : r.freelancer_id,
          project_id: r.project_id,
          min_day: day,
          max_day: day,
          seconds: perDay,
        });
      } else {
        if (day < b.min_day) b.min_day = day;
        if (day > b.max_day) b.max_day = day;
        b.seconds += perDay;
      }
    }
  }

  for (const b of buckets.values()) {
    const spanWd = Math.max(plannerWorkdays(b.min_day, b.max_day).length, 1);
    const alloc = Math.min(b.seconds / (spanWd * 8 * 3600), 1.5);
    await conn.query(
      `INSERT INTO assignment
         (employee_id, freelancer_id, project_id, profile, allocation_pct,
          start_date, end_date, notes, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        b.employee_id,
        b.freelancer_id,
        b.project_id,
        // 'default' rather than NULL: every rate sheet entered for a
        // planner-linked project uses the single 'default' profile, and a
        // NULL profile would fall through to the employee's role tier and
        // resolve revenue to 0.
        "default",
        alloc.toFixed(4),
        b.min_day,
        b.max_day,
        "Synced from awork Planner; edit there to change.",
        PLANNING_ASSIGNMENT_SOURCE,
        now,
      ],
    );
    inserted += 1;
  }

  return {
    deleted_previous: deleted.rowCount ?? 0,
    inserted,
    skipped_unlinked_user: skippedUserPairs.size,
    skipped_unlinked_project: skippedProjectPairs.size,
  };
}

/** Roll time entries up into `freelancer_time_entry` per (assignment,
 * month), where the assignment matches both the linked freelancer and
 * the linked project on the entry's work date. Manual rows always win:
 * the upsert only overwrites rows whose source is 'awork'. */
export async function rollupHoursToFreelancers(
  conn: Client,
): Promise<{ rows_upserted: number }> {
  const rows = await conn.query<{
    assignment_id: number;
    year_month: string;
    hours_decimal: string;
  }>(`
    SELECT
      a.assignment_id,
      to_char(t.work_date, 'YYYY-MM') AS year_month,
      ROUND(SUM(t.duration_minutes)::numeric / 60, 2)::text AS hours_decimal
    FROM time_entry t
    JOIN external_link fl
      ON fl.integration_slug = t.integration_slug
     AND fl.entity_type = 'person'
     AND fl.external_id = t.external_person_id
     AND fl.dante_type = 'freelancer'
    JOIN external_link pl
      ON pl.integration_slug = t.integration_slug
     AND pl.entity_type = 'project'
     AND pl.external_id = t.external_project_id
    JOIN assignment a
      ON a.project_id = pl.dante_id
     AND a.freelancer_id = fl.dante_id
     AND t.work_date >= a.start_date
     AND (a.end_date IS NULL OR t.work_date <= a.end_date)
    GROUP BY a.assignment_id, to_char(t.work_date, 'YYYY-MM')
  `);

  let upserts = 0;
  for (const r of rows.rows) {
    const result = await conn.query(
      `INSERT INTO freelancer_time_entry
         (assignment_id, year_month, hours_decimal, source, entered_at)
       VALUES ($1, $2, $3, 'awork', now())
       ON CONFLICT (assignment_id, year_month) DO UPDATE
         SET hours_decimal = EXCLUDED.hours_decimal,
             entered_at = now()
         WHERE freelancer_time_entry.source = 'awork'`,
      [r.assignment_id, r.year_month, r.hours_decimal],
    );
    if (result.rowCount && result.rowCount > 0) upserts += 1;
  }
  return { rows_upserted: upserts };
}
