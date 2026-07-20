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
  const teamFilter = opts.team
    ? sql` AND ann.team_user = ${opts.team}`
    : sql``;

  const result = await db.execute(sql`
    WITH awork_days AS (
      -- (employee, day) pairs where the person tracked in awork.
      SELECT DISTINCT ul.employee_id, t.work_date
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE t.work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
    ),
    personio AS (
      SELECT a.employee_id,
             CASE
               WHEN a.project_id IS NULL THEN 'untagged'
               WHEN pl.project_id IS NOT NULL
                 THEN CASE WHEN pp_proj.billable THEN 'billable' ELSE 'non_billable' END
               ELSE CASE WHEN COALESCE(pp.billable, TRUE) THEN 'billable' ELSE 'non_billable' END
             END AS bucket,
             a.duration_minutes AS dm
      FROM attendance a
      LEFT JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      LEFT JOIN project pp_proj ON pp_proj.project_id = pl.project_id
      LEFT JOIN personio_project pp ON pp.personio_project_id = a.project_id
      WHERE a.work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
        -- day-level reconciliation: drop Personio on days the person tracked awork
        AND NOT EXISTS (
          SELECT 1 FROM awork_days ad
          WHERE ad.employee_id = a.employee_id AND ad.work_date = a.work_date
        )
    ),
    awork AS (
      SELECT ul.employee_id,
             CASE
               WHEN apl.project_id IS NOT NULL
                 THEN CASE WHEN ap_proj.billable THEN 'billable' ELSE 'non_billable' END
               ELSE CASE WHEN COALESCE(ap.is_billable_by_default, TRUE) THEN 'billable' ELSE 'non_billable' END
             END AS bucket,
             t.duration_minutes AS dm
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      LEFT JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      LEFT JOIN project ap_proj ON ap_proj.project_id = apl.project_id
      LEFT JOIN awork_project ap ON ap.awork_project_id = t.awork_project_id
      WHERE t.work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
    ),
    all_tracked AS (
      SELECT * FROM personio UNION ALL SELECT * FROM awork
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
