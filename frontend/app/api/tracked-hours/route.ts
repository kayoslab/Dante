import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { germanFederalHolidays } from "@/lib/db/_de-holidays";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";

function lastOfMonth(monthStart: string): string {
  // monthStart is YYYY-MM-01. Last day = next month - 1 day.
  const d = new Date(monthStart);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "tracked_hours", "expensive");
    const { searchParams } = new URL(req.url);
    const monthParam = searchParams.get("month") ?? "";
    const team = searchParams.get("team");

    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthParam)})`);
    }
    const month_start = `${monthParam}-01`;
    if (isNaN(new Date(month_start).getTime())) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthParam)})`);
    }
    const month_end = lastOfMonth(month_start);

    // Working days in the month, excluding weekends and DE federal holidays.
    const year = Number(monthParam.slice(0, 4));
    const holidays = germanFederalHolidays(year, year);
    let n_working = 0;
    const cur = new Date(month_start);
    const last = new Date(month_end);
    while (cur <= last) {
      const wd = cur.getUTCDay();
      const iso = cur.toISOString().slice(0, 10);
      if (wd !== 0 && wd !== 6 && !holidays.has(iso)) n_working++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const teamFilter = team ? sql` AND ann.team_user = ${team}` : sql``;

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
        WHERE a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      ),
      awork AS (
        SELECT ul.employee_id,
               CASE WHEN apl.project_id IS NOT NULL THEN 'billable' ELSE 'unmapped' END AS bucket,
               t.duration_minutes AS dm
        FROM awork_time_entry t
        JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
        LEFT JOIN awork_project_link apl
          ON apl.awork_project_id = t.awork_project_id
        WHERE t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
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

    let total_b = 0;
    let total_u = 0;
    let total_n = 0;
    const consultants = (result.rows as Array<Record<string, unknown>>).map(
      (r) => {
        const b_h = Math.round(Number(r.b_min ?? 0) / 60);
        const u_h = Math.round(Number(r.u_min ?? 0) / 60);
        const n_h = Math.round(Number(r.n_min ?? 0) / 60);
        total_b += b_h;
        total_u += u_h;
        total_n += n_h;
        return {
          employee_id: r.employee_id,
          first_name: r.first_name,
          last_name: r.last_name,
          team: r.team,
          billable_hours: b_h,
          unmapped_hours: u_h,
          untagged_hours: n_h,
          total_hours: b_h + u_h + n_h,
        };
      },
    );

    return {
      month: monthParam,
      month_start,
      month_end,
      working_days_in_month: n_working,
      n_consultants: consultants.length,
      total_billable_hours: total_b,
      total_unmapped_hours: total_u,
      total_untagged_hours: total_n,
      total_hours: total_b + total_u + total_n,
      consultants,
    };
  });
}
