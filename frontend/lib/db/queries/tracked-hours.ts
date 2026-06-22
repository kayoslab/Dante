/** Per-consultant tracked-hours rollup for `/api/tracked-hours`.
 *
 * Union of two sources: Personio attendance (the canonical billable
 * surface) and awork time entries (the operational layer the team
 * actually clocks against). Buckets:
 *   - billable  — attendance row tagged with a Personio project that
 *                 maps to a Dante project, OR an awork entry whose
 *                 awork project maps to a Dante project.
 *   - unmapped  — tagged in the source, but no link to a Dante project
 *                 (operator hasn't set up the mapping yet).
 *   - untagged  — Personio-only; the user logged time without picking
 *                 a project at all. Awork doesn't allow this, so awork
 *                 contributes nothing to this bucket.
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
  b_min: number;
  u_min: number;
  n_min: number;
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
    WITH personio AS (
      SELECT a.employee_id,
             CASE
               WHEN a.project_id IS NOT NULL AND pl.project_id IS NOT NULL THEN 'billable'
               WHEN a.project_id IS NOT NULL AND pl.project_id IS NULL     THEN 'unmapped'
               ELSE 'untagged'
             END AS bucket,
             a.duration_minutes AS dm
      FROM attendance a
      LEFT JOIN personio_project_link pl
        ON pl.personio_project_id = a.project_id
      WHERE a.work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
    ),
    awork AS (
      SELECT ul.employee_id,
             CASE WHEN apl.project_id IS NOT NULL THEN 'billable' ELSE 'unmapped' END AS bucket,
             t.duration_minutes AS dm
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      LEFT JOIN awork_project_link apl
        ON apl.awork_project_id = t.awork_project_id
      WHERE t.work_date BETWEEN ${opts.month_start}::date AND ${opts.month_end}::date
    ),
    all_tracked AS (
      SELECT * FROM personio UNION ALL SELECT * FROM awork
    )
    SELECT t.employee_id,
           ec.first_name, ec.last_name, ann.team_user AS team,
           SUM(CASE WHEN t.bucket = 'billable' THEN t.dm ELSE 0 END) AS b_min,
           SUM(CASE WHEN t.bucket = 'unmapped' THEN t.dm ELSE 0 END) AS u_min,
           SUM(CASE WHEN t.bucket = 'untagged' THEN t.dm ELSE 0 END) AS n_min
    FROM all_tracked t
    LEFT JOIN employee_current ec ON ec.employee_id = t.employee_id
    LEFT JOIN employee_annotation ann ON ann.employee_id = t.employee_id
    WHERE 1=1 ${teamFilter}
    GROUP BY t.employee_id, ec.first_name, ec.last_name, ann.team_user
    HAVING SUM(t.dm) > 0
    ORDER BY SUM(t.dm) DESC
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    employee_id: r.employee_id as number,
    first_name: (r.first_name as string | null) ?? null,
    last_name: (r.last_name as string | null) ?? null,
    team: (r.team as string | null) ?? null,
    b_min: Number(r.b_min ?? 0),
    u_min: Number(r.u_min ?? 0),
    n_min: Number(r.n_min ?? 0),
  }));
}
