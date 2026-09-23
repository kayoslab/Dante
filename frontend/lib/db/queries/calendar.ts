/** Queries backing `/api/calendar` — the heaviest read endpoint in the
 * app. Five logical pulls feed the per-cell aggregation in the route:
 *
 *   1. `listCalendarEmployees`  — who's visible on the grid
 *   2. `listCalendarAssignments` — day-expanded manual assignments
 *   3. `listCalendarTrackedTime` — Personio + awork actuals
 *   4. `listCalendarPlannedBookings` — awork planner per-day breakdown
 *   5. `listCalendarAbsences` — vacation / sick / etc. day-expanded
 *
 * Per-role field stripping (daily_rate, hire_date, role_tier, the
 * specific absence type) is APP-LEVEL CONCERN — it stays in the route.
 * The queries return everything; the route decides what to ship. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export type CalendarEmployeeRow = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  fte: number | null;
  team_user: string | null;
  role_tier: string | null;
  office: string | null;
  hire_date: string | null;
  effective_end_date: string | null;
};

/** Real employees whose effective contract window intersects the calendar
 * range. Includes `onboarding` hires (Personio's status for a not-yet-started
 * employee — they only flip to `active` on their start date) so future joiners
 * are visible for planning; the hire_date/end-date window below scopes them to
 * the days they're actually employed. `inactive` (departed) staff stay
 * excluded. `include_non_contributing=true` lifts the `is_project_contributing`
 * filter so the operator can audit who's on the bench. Sorted team-then-name
 * to match the existing UI grouping. */
export async function listCalendarEmployees(opts: {
  start: string;
  end: string;
  include_non_contributing: boolean;
}): Promise<CalendarEmployeeRow[]> {
  const contribFilter = opts.include_non_contributing
    ? sql``
    : sql` AND COALESCE(a.is_project_contributing, TRUE) = TRUE`;
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           CASE WHEN ec.weekly_working_hours IS NULL OR ec.weekly_working_hours = 0
                THEN NULL
                ELSE CAST(ec.weekly_working_hours / 40.0 AS NUMERIC(5, 3))
           END AS fte,
           a.team_user,
           rt.role_tier,
           ec.office,
           ec.hire_date,
           LEAST(
               COALESCE(ec.contract_end_date, DATE '9999-12-31'),
               COALESCE(ec.employment_end_date, DATE '9999-12-31')
           ) AS effective_end_date
    FROM employee_current ec
    LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
    LEFT JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id
    WHERE ec.status IN ('active', 'onboarding')
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${opts.end}::date)
      AND LEAST(
          COALESCE(ec.contract_end_date, DATE '9999-12-31'),
          COALESCE(ec.employment_end_date, DATE '9999-12-31')
      ) >= ${opts.start}::date
      ${contribFilter}
    ORDER BY a.team_user NULLS LAST, ec.last_name, ec.first_name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    fte: row.fte === null || row.fte === undefined ? null : Number(row.fte),
    team_user: (row.team_user as string | null) ?? null,
    role_tier: (row.role_tier as string | null) ?? null,
    office: (row.office as string | null) ?? null,
    hire_date: (row.hire_date as string | null) ?? null,
    effective_end_date: (row.effective_end_date as string | null) ?? null,
  }));
}

export type CalendarAssignmentRow = {
  employee_id: number;
  day: string;
  assignment_id: number;
  project_id: number;
  allocation_pct: number;
  customer_name: string;
  project_name: string;
  profile: string | null;
  effective_daily_rate_eur: string | null;
};

/** Day-expanded manual assignments for the window. CROSS JOIN against
 * a generated date range so we get one row per (assignment, day) for
 * cell-level rollup in the route. */
export async function listCalendarAssignments(opts: {
  start: string;
  end: string;
}): Promise<CalendarAssignmentRow[]> {
  const r = await db.execute(sql`
    WITH date_range AS (
      SELECT generate_series(${opts.start}::date, ${opts.end}::date, '1 day'::interval)::date AS day
    )
    SELECT
      a.employee_id,
      d.day,
      a.assignment_id,
      a.project_id,
      CAST(a.allocation_pct AS double precision) AS allocation_pct,
      c.name AS customer_name,
      p.name AS project_name,
      COALESCE(a.profile, rt.role_tier) AS profile,
      aer.effective_daily_rate_eur
    FROM assignment a
    CROSS JOIN date_range d
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN employee_role_tier rt ON rt.employee_id = a.employee_id
    LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
    WHERE a.employee_id IS NOT NULL
      AND a.source = 'manual'
      AND a.start_date <= d.day
      AND (a.end_date IS NULL OR a.end_date >= d.day)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    day: row.day as string,
    assignment_id: row.assignment_id as number,
    project_id: row.project_id as number,
    allocation_pct: Number(row.allocation_pct),
    customer_name: row.customer_name as string,
    project_name: row.project_name as string,
    profile: (row.profile as string | null) ?? null,
    effective_daily_rate_eur:
      row.effective_daily_rate_eur === null ||
      row.effective_daily_rate_eur === undefined
        ? null
        : String(row.effective_daily_rate_eur),
  }));
}

export type CalendarTrackedRow = {
  employee_id: number | null;
  work_date: string;
  project_name: string;
  minutes: number;
  source: "personio" | "awork";
  dante_project_id: number | null;
  awork_project_id: string | null;
};

/** Per-day tracked time, union of Personio attendance + awork time
 * entries. Awork rows carry both their native `awork_project_id` and
 * the linked `dante_project_id` (when mapped) so the per-cell load math
 * in the route can collapse manual + tracked into a single project key.
 *
 * NOTE: deliberately NOT day-level-reconciled against awork (unlike the
 * tracked-hours/forecast reports). The calendar's Personio corner number is
 * a standalone signal — it should always show the raw Personio-tracked hours
 * so a manager can see whether someone logged time in Personio *in addition*
 * to awork (an overtime / double-tracking check). Personio only feeds the
 * cell LOAD as a past-day fallback when the cell has NO awork time at all
 * (see lib/api/_calendar-load.ts), so there is no double-count to
 * reconcile here. */
export async function listCalendarTrackedTime(opts: {
  start: string;
  end: string;
}): Promise<CalendarTrackedRow[]> {
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT a.employee_id, a.work_date,
             COALESCE(pp.name, 'Untagged') AS project_name,
             SUM(a.duration_minutes) AS minutes,
             'personio' AS source
      FROM attendance a
      LEFT JOIN personio_project pp ON pp.personio_project_id = a.project_id
      WHERE a.work_date BETWEEN ${opts.start}::date AND ${opts.end}::date
      GROUP BY a.employee_id, a.work_date, pp.name
    ),
    awork AS (
      SELECT ul.employee_id, t.work_date,
             COALESCE(ap.name, 'Untagged') AS project_name,
             -- Dante project_id when the awork project is mapped to a
             -- Dante project (used to merge with manual assignment
             -- allocations at the load-calculation step). NULL when
             -- the awork project isn't linked.
             apl.project_id AS dante_project_id,
             t.awork_project_id,
             SUM(t.duration_minutes) AS minutes,
             'awork' AS source
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      LEFT JOIN awork_project ap ON ap.awork_project_id = t.awork_project_id
      LEFT JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      WHERE t.work_date BETWEEN ${opts.start}::date AND ${opts.end}::date
      GROUP BY ul.employee_id, t.work_date, ap.name, apl.project_id, t.awork_project_id
    )
    SELECT employee_id, work_date, project_name, minutes, source,
           dante_project_id, awork_project_id
    FROM (
      SELECT employee_id, work_date, project_name, minutes, source,
             NULL::integer AS dante_project_id, NULL::text AS awork_project_id
      FROM personio
      UNION ALL
      SELECT employee_id, work_date, project_name, minutes, source,
             dante_project_id, awork_project_id
      FROM awork
    ) u
    ORDER BY employee_id, work_date
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: (row.employee_id as number | null) ?? null,
    work_date: row.work_date as string,
    project_name: row.project_name as string,
    minutes: Number(row.minutes ?? 0),
    source: row.source as "personio" | "awork",
    dante_project_id: (row.dante_project_id as number | null) ?? null,
    awork_project_id: (row.awork_project_id as string | null) ?? null,
  }));
}

export type CalendarPlannedRow = {
  employee_id: number | null;
  day: string;
  project_name: string;
  dante_project_id: number | null;
  awork_project_id: string | null;
  per_day_seconds: number;
};

/** Per-day planned breakdown for the tooltip. The same data already
 * feeds `assignment.allocation_pct` via the sync rollup (so it drives
 * the cell color), but the operator wants to see exactly what hours
 * are scheduled for which project each day — surface that separately.
 * Divisor uses the FULL booking range (not the calendar window) so a
 * booking that straddles the window's edge doesn't inflate the visible
 * days' share. */
export async function listCalendarPlannedBookings(opts: {
  start: string;
  end: string;
}): Promise<CalendarPlannedRow[]> {
  const r = await db.execute(sql`
    SELECT
      ul.employee_id,
      d::date AS day,
      COALESCE(ap.name, 'Untagged') AS project_name,
      apl.project_id AS dante_project_id,
      tb.awork_project_id,
      tb.duration_seconds * 1.0 / GREATEST(
        (
          SELECT COUNT(*)
          FROM generate_series(tb.start_date, tb.end_date, '1 day'::interval) gd
          WHERE EXTRACT(DOW FROM gd) NOT IN (0, 6)
        ),
        1
      ) AS per_day_seconds
    FROM awork_time_booking tb
    JOIN awork_user_link ul ON ul.awork_user_id = tb.awork_user_id
    LEFT JOIN awork_project ap ON ap.awork_project_id = tb.awork_project_id
    LEFT JOIN awork_project_link apl ON apl.awork_project_id = tb.awork_project_id
    CROSS JOIN LATERAL generate_series(
      GREATEST(tb.start_date, ${opts.start}::date),
      LEAST(tb.end_date, ${opts.end}::date),
      '1 day'::interval
    ) d
    WHERE EXTRACT(DOW FROM d) NOT IN (0, 6)
      AND tb.end_date >= ${opts.start}::date
      AND tb.start_date <= ${opts.end}::date
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: (row.employee_id as number | null) ?? null,
    day: row.day as string,
    project_name: row.project_name as string,
    dante_project_id: (row.dante_project_id as number | null) ?? null,
    awork_project_id: (row.awork_project_id as string | null) ?? null,
    per_day_seconds: Number(row.per_day_seconds ?? 0),
  }));
}

export type CalendarAbsenceRow = {
  employee_id: number;
  day: string;
  time_off_type: string | null;
};

/** Day-expanded absences over the window. `time_off_type` is the raw
 * Personio category (Krankheit / Urlaub / etc.). The route collapses
 * health-related types to "absence" for non-managers — that decision
 * is APP-LEVEL CONCERN, not query-level. */
export async function listCalendarAbsences(opts: {
  start: string;
  end: string;
}): Promise<CalendarAbsenceRow[]> {
  const r = await db.execute(sql`
    WITH date_range AS (
      SELECT generate_series(${opts.start}::date, ${opts.end}::date, '1 day'::interval)::date AS day
    )
    SELECT abs.employee_id, d.day, abs.time_off_type
    FROM absence abs
    CROSS JOIN date_range d
    WHERE d.day BETWEEN abs.start_date AND abs.end_date
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    day: row.day as string,
    time_off_type: (row.time_off_type as string | null) ?? null,
  }));
}
