/** Freelancer time-entry gap signal — count of months since a project's
 * freelancer assignment started where no `freelancer_time_entry` row
 * exists. Surfaced as a per-row badge on the Home project list (and the
 * rentability report's project table) so SDMs and managers see what's
 * still unlogged.
 *
 * The SDM-grant lookup that used to live here was consolidated into
 * `listSdmProjectIdsForUser` in `project-sdm.ts` — they were doing the
 * same SELECT against `project_sdm`. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export async function getMissingFreelancerHoursMonthsByProject(
  project_ids?: number[],
): Promise<Map<number, number>> {
  if (project_ids !== undefined && project_ids.length === 0) {
    return new Map();
  }
  // Two query shapes: filtered vs unfiltered. Kept separate rather
  // than parameterising the WHERE clause because the array-IN dance
  // adds noise that obscures the actual gap logic.
  const r =
    project_ids === undefined
      ? await db.execute(sql`
          WITH expected AS (
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
          )
          SELECT e.project_id, COUNT(*)::int AS n_missing
          FROM expected e
          LEFT JOIN freelancer_time_entry fte
            ON fte.assignment_id = e.assignment_id
            AND fte.year_month = to_char(e.month_first, 'YYYY-MM')
          WHERE fte.assignment_id IS NULL
          GROUP BY e.project_id
        `)
      : await db.execute(sql`
          WITH filter AS (
            SELECT unnest(${project_ids}::int[]) AS project_id
          ),
          expected AS (
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
              AND a.project_id IN (SELECT project_id FROM filter)
          )
          SELECT e.project_id, COUNT(*)::int AS n_missing
          FROM expected e
          LEFT JOIN freelancer_time_entry fte
            ON fte.assignment_id = e.assignment_id
            AND fte.year_month = to_char(e.month_first, 'YYYY-MM')
          WHERE fte.assignment_id IS NULL
          GROUP BY e.project_id
        `);
  const map = new Map<number, number>();
  for (const row of r.rows as Array<{
    project_id: number;
    n_missing: number;
  }>) {
    map.set(Number(row.project_id), Number(row.n_missing));
  }
  return map;
}
