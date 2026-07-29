/** Per-consultant tracked-hours rollup for `/api/tracked-hours`.
 *
 * Union of two sources — Personio attendance + awork time entries — classified
 * by *effective billability* (project-level, uniform across sources):
 *   - billable      — tracked on a billable project.
 *   - non_billable  — tracked on a project marked non-billable (internal work,
 *                     e.g. "Interne Tätigkeit").
 *   - untagged      — Personio-only; no project picked.
 * `non_billable + untagged` = internal (non-billed) tracked time. NB: this is
 * NOT "bench" — bench is unused *capacity* (available − allocation), a Forecast-
 * report concept. This report is purely actual tracked hours.
 *
 * Effective billability of a project (same rule both sources):
 *   - source project LINKED to a Dante project → `project.billable`.
 *   - UNLINKED → the source flag (`personio_project.billable` /
 *     `awork_project.is_billable_by_default`), null → billable (interim,
 *     until the source data is curated).
 *   - Personio untagged (no project) → untagged (internal).
 * Sub-projects are flat: each leaf is its own row, linked individually — a
 * parent link does not cascade (see the sub-project decision).
 *
 * **awork day-level reconciliation:** pentesters track real (billable) work in
 * awork but also book placeholder time in Personio ("Generic Pentest" /
 * untagged). For any (employee, day) that has ≥1 awork entry, that day's
 * Personio attendance is dropped as a duplicate — awork is the truth. Non-awork
 * users have no awork days, so all their Personio attendance is kept (untagged
 * = genuine internal / unaccounted time).
 *
 * Roster: every active, real, project-contributing employee appears — even
 * with no tracked time this month (zeros; the gap is the signal). Non-project-
 * contributing employees are excluded entirely, even if they logged time —
 * this report is about the delivery org's utilization only. See the `roster`
 * CTE and the final `is_project_contributing` filter.
 *
 * `team` filter is an exact match on `employee_annotation.team_user`.
 * NULL `team` skips the filter (returns all consultants). */
import { sql } from "drizzle-orm";

import { db } from "../client";
import { officeStateFromAlias } from "../_sql-fragments";

export type TrackedHoursConsultantRow = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  team: string | null;
  b_min: number; // billable
  nb_min: number; // non-billable (internal)
  n_min: number; // untagged
};

export async function getTrackedHoursForMonth(opts: {
  month_start: string;
  month_end: string;
  team: string | null;
}): Promise<TrackedHoursConsultantRow[]> {
  const teamFilter = opts.team ? sql` AND ann.team_user = ${opts.team}` : sql``;

  const result = await db.execute(sql`
    WITH all_tracked AS (
      -- Day-level awork/Personio reconciliation + effective billability
      -- live in the tracked_time_effective VIEW (migration 0022) so every
      -- consumer shares one definition.
      SELECT employee_id, bucket, duration_minutes AS dm
      FROM tracked_time_effective
      WHERE work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
    ),
    agg AS (
      SELECT employee_id,
             SUM(CASE WHEN bucket = 'billable' THEN dm ELSE 0 END) AS b_min,
             SUM(CASE WHEN bucket = 'non_billable' THEN dm ELSE 0 END) AS nb_min,
             SUM(CASE WHEN bucket = 'untagged' THEN dm ELSE 0 END) AS n_min
      FROM all_tracked
      GROUP BY employee_id
    ),
    -- The roster is every active, real, project-contributing employee (so
    -- people who have not tracked time yet this month still appear, with
    -- zeros — the gap is the signal) PLUS anyone who did track time. The
    -- final SELECT then drops any non-project-contributing employee the
    -- agg UNION pulled in, so departed/non-contributing trackers don't
    -- show here even though their time is counted elsewhere.
    roster AS (
      SELECT ec.employee_id
      FROM employee_current ec
      LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
      WHERE ec.status = 'active'
        AND COALESCE(ann.is_real_employee, TRUE) = TRUE
        AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      UNION
      SELECT employee_id FROM agg
    )
    SELECT r.employee_id,
           ec.first_name, ec.last_name, ann.team_user AS team,
           COALESCE(a.b_min, 0) AS b_min,
           COALESCE(a.nb_min, 0) AS nb_min,
           COALESCE(a.n_min, 0) AS n_min
    FROM roster r
    LEFT JOIN employee_current ec ON ec.employee_id = r.employee_id
    LEFT JOIN employee_annotation ann ON ann.employee_id = r.employee_id
    LEFT JOIN agg a ON a.employee_id = r.employee_id
    -- Non-project-contributing employees are excluded from this report
    -- entirely — even if they logged time (the agg UNION would otherwise
    -- re-add them). Missing annotation defaults to contributing (TRUE).
    WHERE COALESCE(ann.is_project_contributing, TRUE) = TRUE ${teamFilter}
    ORDER BY (COALESCE(a.b_min, 0) + COALESCE(a.nb_min, 0) + COALESCE(a.n_min, 0)) DESC,
             ec.last_name, ec.first_name
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    employee_id: r.employee_id as number,
    first_name: (r.first_name as string | null) ?? null,
    last_name: (r.last_name as string | null) ?? null,
    team: (r.team as string | null) ?? null,
    b_min: Number(r.b_min ?? 0),
    nb_min: Number(r.nb_min ?? 0),
    n_min: Number(r.n_min ?? 0),
  }));
}

/** Available hours per employee for the month, per contract and location:
 * contract-clipped working days (weekends + holidays excluded, holidays
 * state-specific via the employee's office, NRW-agnostic federal fallback)
 * × standard daily hours (weekly_working_hours ÷ 5, default 8), minus
 * weighted absence days (paid + unpaid; Personio half-days count 0.5).
 *
 * This is the "how much could they have worked" reference the time-tracking
 * report shows next to tracked hours — same construction as the Forecast
 * capacity model's `available`. Full-month figure regardless of today. */
export async function getAvailableHoursForEmployees(
  employee_ids: number[],
  month_start: string,
  month_end: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (employee_ids.length === 0) return out;
  const idList = sql.join(
    employee_ids.map((id) => sql`${id}`),
    sql`, `,
  );
  // One set query for all employees: working days come from Mon–Fri minus
  // the employee's state_holiday calendar (office → state via the same map
  // the TS engines use), absence weights from the absence_day view. The
  // final arithmetic stays in TS so rounding matches the other engines.
  const r = await db.execute(sql`
    WITH emp AS (
      SELECT ec.employee_id, ec.weekly_working_hours, ec.hire_date,
             ec.employment_end_date,
             ${officeStateFromAlias("ec")} AS state
      FROM employee_current ec
      WHERE ec.employee_id IN (${idList})
    ),
    wd AS (
      -- Contract-clipped working days of the month, per employee.
      SELECT e.employee_id, d.dy::date AS dy
      FROM emp e
      CROSS JOIN generate_series(
        ${month_start}::date, ${month_end}::date, interval '1 day'
      ) AS d(dy)
      WHERE EXTRACT(ISODOW FROM d.dy) < 6
        AND NOT EXISTS (
          SELECT 1 FROM state_holiday h
          WHERE h.state = e.state AND h.day = d.dy::date
        )
        AND (e.hire_date IS NULL OR d.dy::date >= e.hire_date)
        AND (e.employment_end_date IS NULL OR d.dy::date <= e.employment_end_date)
    )
    SELECT e.employee_id, e.weekly_working_hours,
           COUNT(w.dy) AS contract_wd,
           COALESCE(SUM(ad.weight), 0) AS absent_w
    FROM emp e
    LEFT JOIN wd w ON w.employee_id = e.employee_id
    LEFT JOIN absence_day ad
      ON ad.employee_id = w.employee_id AND ad.day = w.dy
    GROUP BY e.employee_id, e.weekly_working_hours
  `);
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const emp_id = raw.employee_id as number;
    const wkh =
      raw.weekly_working_hours === null ||
      raw.weekly_working_hours === undefined
        ? null
        : Number(raw.weekly_working_hours);
    const contract_wd = Number(raw.contract_wd ?? 0);
    if (contract_wd === 0) {
      out.set(emp_id, 0);
      continue;
    }
    const absentW = Number(raw.absent_w ?? 0);
    const daily = wkh !== null && wkh > 0 ? wkh / 5 : 8;
    const available = Math.max(contract_wd - absentW, 0) * daily;
    out.set(emp_id, Number(available.toFixed(1)));
  }
  return out;
}
