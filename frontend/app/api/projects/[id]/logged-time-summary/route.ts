import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    await requireApiProjectAccess(project_id);

    const proj = await db.execute(sql`
      SELECT name FROM project WHERE project_id = ${project_id}
    `);
    const pRow = (proj.rows as Array<{ name: string }>)[0];
    if (!pRow) throw NotFound(`project not found: ${project_id}`);
    const project_name = pRow.name;

    // Dedup per (employee, day) between Personio and awork so a project
    // mapped in both doesn't double-count tracked hours.
    const result = await db.execute(sql`
      WITH personio AS (
        SELECT a.employee_id, a.work_date,
               SUM(a.duration_minutes) AS minutes
        FROM attendance a
        JOIN personio_project_link pl
          ON pl.personio_project_id = a.project_id
        WHERE pl.project_id = ${project_id}
        GROUP BY a.employee_id, a.work_date
      ),
      awork AS (
        SELECT ul.employee_id, t.work_date,
               SUM(t.duration_minutes) AS minutes
        FROM awork_time_entry t
        JOIN awork_project_link apl
          ON apl.awork_project_id = t.awork_project_id
        JOIN awork_user_link ul
          ON ul.awork_user_id = t.awork_user_id
        WHERE apl.project_id = ${project_id}
        GROUP BY ul.employee_id, t.work_date
      ),
      deduped AS (
        SELECT employee_id, work_date, MAX(minutes) AS minutes
        FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
        GROUP BY employee_id, work_date
      ),
      consolidated AS (
        SELECT
          d.employee_id,
          SUM(d.minutes) AS total_min,
          MIN(d.work_date) AS earliest,
          MAX(d.work_date) AS latest,
          MAX(CASE WHEN EXISTS (SELECT 1 FROM personio p WHERE p.employee_id = d.employee_id AND p.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_personio,
          MAX(CASE WHEN EXISTS (SELECT 1 FROM awork w WHERE w.employee_id = d.employee_id AND w.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_awork
        FROM deduped d
        GROUP BY d.employee_id
      )
      SELECT
        c.employee_id,
        ec.first_name || ' ' || ec.last_name AS who_name,
        c.total_min, c.earliest, c.latest,
        c.has_personio, c.has_awork,
        (SELECT COUNT(*) FROM assignment a
         WHERE a.employee_id = c.employee_id AND a.project_id = ${project_id}) AS n_assignments
      FROM consolidated c
      LEFT JOIN employee_current ec ON ec.employee_id = c.employee_id
      WHERE c.total_min > 0
      ORDER BY c.total_min DESC
    `);

    let total_hours = 0;
    const consultants: Array<Record<string, unknown>> = [];
    for (const raw of result.rows as Array<Record<string, unknown>>) {
      const total_min = Number(raw.total_min ?? 0);
      const hours = Math.round(total_min / 60);
      if (hours === 0) continue;
      const days = Math.round((hours / 8) * 1000) / 1000;
      const sources: string[] = [];
      if (Number(raw.has_personio) === 1) sources.push("personio");
      if (Number(raw.has_awork) === 1) sources.push("awork");
      consultants.push({
        employee_id: raw.employee_id,
        who_name: raw.who_name,
        total_hours: hours,
        total_days: days.toFixed(3),
        first_log_date: raw.earliest,
        last_log_date: raw.latest,
        sources,
        n_assignments: Number(raw.n_assignments ?? 0),
      });
      total_hours += hours;
    }

    return {
      project_id,
      project_name,
      n_consultants: consultants.length,
      total_hours,
      total_days: (total_hours / 8).toFixed(3),
      consultants,
    };
  });
}
