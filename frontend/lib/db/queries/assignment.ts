import { sql } from "drizzle-orm";

import { db } from "../client";

export type AssignmentDetail = {
  assignment_id: number;
  kind: "employee" | "freelancer";
  who_name: string | null;
  employee_id: number | null;
  freelancer_id: number | null;
  project_id: number;
  project_name: string;
  customer_name: string;
  profile: string | null;
  allocation_pct: string;
  start_date: string | null;
  end_date: string | null;
  daily_rate_override_eur: string | null;
  daily_cost_override_eur: string | null;
  effective_profile: string | null;
  effective_daily_rate_eur: string | null;
  rate_source: string | null;
  notes: string | null;
  created_at: string;
};

export async function getAssignmentDetail(
  assignment_id: number,
): Promise<AssignmentDetail | null> {
  const r = await db.execute(sql`
    SELECT a.assignment_id,
           CASE WHEN a.employee_id IS NOT NULL THEN 'employee' ELSE 'freelancer' END AS kind,
           COALESCE(ec.first_name || ' ' || ec.last_name, f.name) AS who_name,
           a.employee_id, a.freelancer_id, a.project_id,
           p.name AS project_name, c.name AS customer_name,
           a.profile, a.allocation_pct,
           a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur,
           aer.effective_profile, aer.effective_daily_rate_eur, aer.rate_source,
           a.notes, a.created_at
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    LEFT JOIN freelancer f ON f.freelancer_id = a.freelancer_id
    LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
    WHERE a.assignment_id = ${assignment_id}
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    assignment_id: row.assignment_id as number,
    kind: row.kind as "employee" | "freelancer",
    who_name: (row.who_name as string | null) ?? null,
    employee_id: (row.employee_id as number | null) ?? null,
    freelancer_id: (row.freelancer_id as number | null) ?? null,
    project_id: row.project_id as number,
    project_name: row.project_name as string,
    customer_name: row.customer_name as string,
    profile: (row.profile as string | null) ?? null,
    allocation_pct: String(row.allocation_pct),
    start_date: (row.start_date as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? null,
    daily_rate_override_eur:
      row.daily_rate_override_eur === null ||
      row.daily_rate_override_eur === undefined
        ? null
        : String(row.daily_rate_override_eur),
    daily_cost_override_eur:
      row.daily_cost_override_eur === null ||
      row.daily_cost_override_eur === undefined
        ? null
        : String(row.daily_cost_override_eur),
    effective_profile: (row.effective_profile as string | null) ?? null,
    effective_daily_rate_eur:
      row.effective_daily_rate_eur === null ||
      row.effective_daily_rate_eur === undefined
        ? null
        : String(row.effective_daily_rate_eur),
    rate_source: (row.rate_source as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_at: new Date(row.created_at as Date | string).toISOString(),
  };
}
