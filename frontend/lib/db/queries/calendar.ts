/** Queries backing `/api/calendar` — the heaviest read endpoint in the
 * app. Five logical pulls feed the per-cell aggregation in the route:
 *
 *   1. `listCalendarEmployees`  — who's visible on the grid
 *   2. `listCalendarAssignments` — day-expanded manual assignments
 *   3. `listCalendarTrackedTime` — actuals from every time-entry source
 *   4. `listCalendarPlannedBookings` — planner per-day breakdown
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
  /** The integration the time came from (its slug). */
  source: string;
  /** True when the source is the primary `people` integration — the HRIS
   *  whose attendance is the calendar's corner number. */
  is_attendance: boolean;
  dante_project_id: number | null;
  external_project_id: string | null;
};

/** Per-day tracked time from every integration bound to `time_entries`.
 * Rows carry both the source's own project id and the linked
 * `dante_project_id` (when mapped) so the per-cell load math in the route
 * can collapse manual + tracked into a single project key.
 *
 * `is_attendance` marks the HRIS (primary `people` source): its hours are
 * the calendar's corner number, a standalone signal that always shows the
 * raw attendance so a manager can see whether someone logged time there
 * *in addition* to the delivery tool (an overtime / double-tracking
 * check). Attendance only feeds the cell LOAD as a past-day fallback when
 * the cell has NO delivery-tool time at all (see lib/api/_calendar-load.ts),
 * so this query deliberately does NOT reconcile overlapping days. */
export async function listCalendarTrackedTime(opts: {
  start: string;
  end: string;
}): Promise<CalendarTrackedRow[]> {
  const r = await db.execute(sql`
    WITH hris AS (
      SELECT integration_slug FROM integration_binding
      WHERE capability = 'people' AND priority = 0 AND enabled
    )
    SELECT r.employee_id, r.work_date,
           COALESCE(r.external_project_name, 'Untagged') AS project_name,
           SUM(r.duration_minutes) AS minutes,
           r.integration_slug AS source,
           (r.integration_slug IN (SELECT integration_slug FROM hris)) AS is_attendance,
           r.project_id AS dante_project_id,
           r.external_project_id
    FROM time_entry_resolved r
    WHERE r.employee_id IS NOT NULL
      AND r.work_date BETWEEN ${opts.start}::date AND ${opts.end}::date
    GROUP BY r.employee_id, r.work_date, r.external_project_name, r.integration_slug,
             r.project_id, r.external_project_id
    ORDER BY r.employee_id, r.work_date
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: (row.employee_id as number | null) ?? null,
    work_date: row.work_date as string,
    project_name: row.project_name as string,
    minutes: Number(row.minutes ?? 0),
    source: row.source as string,
    is_attendance: Boolean(row.is_attendance),
    dante_project_id: (row.dante_project_id as number | null) ?? null,
    external_project_id: (row.external_project_id as string | null) ?? null,
  }));
}

export type CalendarPlannedRow = {
  employee_id: number | null;
  day: string;
  project_name: string;
  dante_project_id: number | null;
  external_project_id: string | null;
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
      b.employee_id,
      d::date AS day,
      COALESCE(b.external_project_name, 'Untagged') AS project_name,
      b.project_id AS dante_project_id,
      b.external_project_id,
      b.duration_seconds * 1.0 / GREATEST(
        (
          SELECT COUNT(*)
          FROM generate_series(b.start_date, b.end_date, '1 day'::interval) gd
          WHERE EXTRACT(DOW FROM gd) NOT IN (0, 6)
        ),
        1
      ) AS per_day_seconds
    FROM planned_booking_resolved b
    CROSS JOIN LATERAL generate_series(
      GREATEST(b.start_date, ${opts.start}::date),
      LEAST(b.end_date, ${opts.end}::date),
      '1 day'::interval
    ) d
    WHERE b.employee_id IS NOT NULL
      AND EXTRACT(DOW FROM d) NOT IN (0, 6)
      AND b.end_date >= ${opts.start}::date
      AND b.start_date <= ${opts.end}::date
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: (row.employee_id as number | null) ?? null,
    day: row.day as string,
    project_name: row.project_name as string,
    dante_project_id: (row.dante_project_id as number | null) ?? null,
    external_project_id: (row.external_project_id as string | null) ?? null,
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
