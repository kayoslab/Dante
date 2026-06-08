import { sql } from "drizzle-orm";

import { db } from "../client";
import { roleTierFromAlias } from "../_sql-fragments";

export type EmployeeDetail = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  department: string | null;
  position: string | null;
  subcompany: string | null;
  office: string | null;
  employment_type: string | null;
  hire_date: string | null;
  contract_end_date: string | null;
  employment_end_date: string | null;
  probation_period_end: string | null;
  notice_period_probation: string | null;
  weekly_working_hours: string | null;
  fte: number | null;
  fix_salary: string | null;
  fix_salary_interval: string | null;
  hourly_salary: string | null;
  cost_center: string | null;
  gender: string | null;
  nationality: string | null;
  birth_date: string | null;
  supervisor_id: number | null;
  supervisor_name: string | null;
  direct_reports: Array<{
    employee_id: number;
    first_name: string | null;
    last_name: string | null;
  }>;
  team: string | null;
  is_real_employee: boolean | null;
  is_project_contributing: boolean | null;
  is_multi_org: boolean | null;
  role_tier: string | null;
};

const sNum = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function pyFloat(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

export async function getEmployeeDetail(
  employee_id: number,
): Promise<EmployeeDetail | null> {
  const roleTier = roleTierFromAlias("ec", "a");

  const detailResult = await db.execute(sql`
    SELECT
      ec.employee_id, ec.first_name, ec.last_name, ec.email, ec.status,
      ec.department, ec.position, ec.subcompany, ec.office,
      ec.employment_type, ec.hire_date, ec.contract_end_date,
      ec.employment_end_date, ec.probation_period_end,
      ec.notice_period_probation, ec.weekly_working_hours,
      CASE WHEN ec.weekly_working_hours IS NULL OR ec.weekly_working_hours = 0
           THEN NULL
           ELSE CAST(ec.weekly_working_hours / 40.0 AS NUMERIC(5, 3))
      END AS fte,
      ec.fix_salary, ec.fix_salary_interval, ec.hourly_salary,
      ec.cost_center, ec.gender, ec.nationality, ec.birth_date,
      ec.supervisor_id,
      sup.first_name AS sup_first, sup.last_name AS sup_last,
      a.team_user, a.is_real_employee, a.is_project_contributing,
      a.is_multi_org,
      ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_current sup ON sup.employee_id = ec.supervisor_id
    LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
    WHERE ec.employee_id = ${employee_id}
  `);
  const row = (detailResult.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const reportsResult = await db.execute(sql`
    SELECT employee_id, first_name, last_name FROM employee_current
    WHERE supervisor_id = ${employee_id} AND status = 'active'
    ORDER BY last_name, first_name
  `);

  const sup_first = row.sup_first as string | null;
  const sup_last = row.sup_last as string | null;
  let supervisor_name: string | null = null;
  if (sup_first || sup_last) {
    supervisor_name = `${sup_first ?? ""} ${sup_last ?? ""}`.trim();
  }

  return {
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    department: (row.department as string | null) ?? null,
    position: (row.position as string | null) ?? null,
    subcompany: (row.subcompany as string | null) ?? null,
    office: (row.office as string | null) ?? null,
    employment_type: (row.employment_type as string | null) ?? null,
    hire_date: (row.hire_date as string | null) ?? null,
    contract_end_date: (row.contract_end_date as string | null) ?? null,
    employment_end_date: (row.employment_end_date as string | null) ?? null,
    probation_period_end: (row.probation_period_end as string | null) ?? null,
    notice_period_probation: (row.notice_period_probation as string | null) ?? null,
    weekly_working_hours: pyFloat(row.weekly_working_hours),
    fte: row.fte === null || row.fte === undefined ? null : Number(row.fte),
    fix_salary: sNum(row.fix_salary),
    fix_salary_interval: (row.fix_salary_interval as string | null) ?? null,
    hourly_salary: sNum(row.hourly_salary),
    cost_center: (row.cost_center as string | null) ?? null,
    gender: (row.gender as string | null) ?? null,
    nationality: (row.nationality as string | null) ?? null,
    birth_date: (row.birth_date as string | null) ?? null,
    supervisor_id: (row.supervisor_id as number | null) ?? null,
    supervisor_name,
    direct_reports: (reportsResult.rows as Array<Record<string, unknown>>).map(
      (r) => ({
        employee_id: r.employee_id as number,
        first_name: (r.first_name as string | null) ?? null,
        last_name: (r.last_name as string | null) ?? null,
      }),
    ),
    team: (row.team_user as string | null) ?? null,
    is_real_employee: (row.is_real_employee as boolean | null) ?? null,
    is_project_contributing: (row.is_project_contributing as boolean | null) ?? null,
    is_multi_org: (row.is_multi_org as boolean | null) ?? null,
    role_tier: (row.role_tier as string | null) ?? null,
  };
}
