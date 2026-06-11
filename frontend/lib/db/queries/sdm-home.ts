/** SDM Home dashboard query.
 *
 * Per-project tile data for the "Projects I manage" section that renders
 * for employee-role users with `project_sdm` grants. Covers:
 *   - project name + customer
 *   - count of freelancer assignments on the project
 *   - missing-hours nag: months where a freelancer assignment is active
 *     but no `freelancer_time_entry` row exists for it
 *
 * One query for the whole section — no N+1 per project. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export type SdmProjectTile = {
  project_id: number;
  name: string;
  customer_id: number;
  customer_name: string;
  status: string;
  n_freelancer_assignments: number;
  n_missing_months: number;
};

export async function getSdmProjectTiles(
  user_id: string,
): Promise<SdmProjectTile[]> {
  const r = await db.execute(sql`
    WITH my_projects AS (
      SELECT project_id FROM project_sdm WHERE user_id = ${user_id}
    ),
    expected AS (
      -- One row per (freelancer assignment, month it was active up to today).
      -- generate_series gives us a row for every month between the
      -- assignment start and min(end, today).
      SELECT
        a.assignment_id,
        a.project_id,
        m::date AS month_first
      FROM assignment a
      CROSS JOIN LATERAL generate_series(
        date_trunc('month', a.start_date)::date,
        LEAST(
          date_trunc('month', COALESCE(a.end_date, CURRENT_DATE))::date,
          date_trunc('month', CURRENT_DATE)::date
        ),
        interval '1 month'
      ) AS m
      WHERE a.freelancer_id IS NOT NULL
        AND a.project_id IN (SELECT project_id FROM my_projects)
    ),
    gaps AS (
      SELECT e.project_id, COUNT(*) AS n_missing
      FROM expected e
      LEFT JOIN freelancer_time_entry fte
        ON fte.assignment_id = e.assignment_id
        AND fte.year_month = to_char(e.month_first, 'YYYY-MM')
      WHERE fte.assignment_id IS NULL
      GROUP BY e.project_id
    )
    SELECT
      p.project_id, p.name, p.status,
      c.customer_id, c.name AS customer_name,
      (SELECT COUNT(*) FROM assignment a
       WHERE a.project_id = p.project_id AND a.freelancer_id IS NOT NULL
      )::int AS n_freelancer_assignments,
      COALESCE(g.n_missing, 0)::int AS n_missing_months
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN gaps g ON g.project_id = p.project_id
    WHERE p.project_id IN (SELECT project_id FROM my_projects)
    ORDER BY p.name
  `);

  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    project_id: row.project_id as number,
    name: row.name as string,
    customer_id: row.customer_id as number,
    customer_name: row.customer_name as string,
    status: row.status as string,
    n_freelancer_assignments: row.n_freelancer_assignments as number,
    n_missing_months: row.n_missing_months as number,
  }));
}
