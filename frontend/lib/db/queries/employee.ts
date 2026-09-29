import { and, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { roleTierFromAlias } from "../_sql-fragments";
import {
  employeeCurrent,
} from "../schema";

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

export type EmployeeAllocationRow = {
  assignment_id: unknown;
  project_id: unknown;
  project_name: unknown;
  customer_name: unknown;
  billing_model: unknown;
  profile: unknown;
  allocation_pct: string;
  start_date: unknown;
  end_date: unknown;
  is_active_today: boolean;
  effective_daily_rate_eur: string | null;
};

export async function getEmployeeAllocations(
  employee_id: number,
): Promise<EmployeeAllocationRow[]> {
  // role_tier needs ec + ann aliases. The rate-resolution subqueries are
  // inlined rather than fragment-composed — they reference outer aliases
  // (`a`, `p`) which is awkward to express via a generic helper.
  const roleTier = roleTierFromAlias("ec", "ann");
  const result = await db.execute(sql`
    SELECT
      a.assignment_id, a.project_id, p.name AS project_name,
      c.name AS customer_name, p.billing_model,
      COALESCE(a.profile, ${roleTier}) AS profile,
      a.allocation_pct, a.start_date, a.end_date,
      COALESCE(
        a.daily_rate_override_eur,
        (SELECT daily_rate_eur FROM project_rate pr
         WHERE pr.project_id = a.project_id
           AND pr.profile = COALESCE(a.profile, ${roleTier})
           AND pr.valid_from <= a.start_date
         ORDER BY pr.valid_from DESC LIMIT 1),
        (SELECT daily_rate_eur FROM framework_rate fr
         WHERE fr.framework_id = p.framework_id
           AND fr.profile = COALESCE(a.profile, ${roleTier})
           AND fr.valid_from <= a.start_date
         ORDER BY fr.valid_from DESC LIMIT 1)
      ) AS effective_daily_rate_eur,
      (a.start_date <= CURRENT_DATE
       AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)) AS is_active_today
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    LEFT JOIN employee_annotation ann ON ann.employee_id = a.employee_id
    WHERE a.employee_id = ${employee_id}
    ORDER BY a.start_date DESC, a.assignment_id DESC
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    assignment_id: r.assignment_id,
    project_id: r.project_id,
    project_name: r.project_name,
    customer_name: r.customer_name,
    billing_model: r.billing_model,
    profile: r.profile,
    allocation_pct: Number(r.allocation_pct).toFixed(4),
    start_date: r.start_date,
    end_date: r.end_date,
    is_active_today: Boolean(r.is_active_today),
    effective_daily_rate_eur:
      r.effective_daily_rate_eur === null || r.effective_daily_rate_eur === undefined
        ? null
        : Number(r.effective_daily_rate_eur).toFixed(2),
  }));
}


export async function employeeExists(employee_id: number): Promise<boolean> {
  const rows = await db
    .select({ id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  return rows.length > 0;
}
