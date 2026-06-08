/** Shared employee-list query used by:
 *   - the `/api/employees` GET route handler
 *   - server-side prefetch on the employees page (Phase D)
 */
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  effectiveEndDateFromAlias,
  roleTierFromAlias,
} from "../_sql-fragments";

export type EmployeeListRow = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  department: string | null;
  team: string | null;
  role_tier: string | null;
  position: string | null;
  fte: number | null;
  is_real_employee: boolean | null;
  is_project_contributing: boolean | null;
  is_multi_org: boolean | null;
  contract_end_date: string | null;
};

export type EmployeeListFilters = {
  q?: string;
  status?: string;
  team?: string;
  include_excluded?: boolean;
};

export async function listEmployees(
  filters: EmployeeListFilters = {},
): Promise<EmployeeListRow[]> {
  const includeExcluded = filters.include_excluded ?? true;

  const conditions = [sql`1=1`];
  if (!includeExcluded) {
    conditions.push(sql`COALESCE(a.is_real_employee, TRUE) = TRUE`);
  }
  if (filters.status) {
    conditions.push(sql`ec.status = ${filters.status}`);
  }
  if (filters.team) {
    conditions.push(sql`a.team_user = ${filters.team}`);
  }
  if (filters.q) {
    const like = `%${filters.q}%`;
    conditions.push(sql`(
      LOWER(ec.first_name) LIKE LOWER(${like}) OR
      LOWER(ec.last_name) LIKE LOWER(${like}) OR
      LOWER(ec.email) LIKE LOWER(${like})
    )`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const roleTier = roleTierFromAlias("ec", "a");
  const effEnd = effectiveEndDateFromAlias("ec");

  const result = await db.execute(sql`
    SELECT
      ec.employee_id,
      ec.first_name,
      ec.last_name,
      ec.status,
      ec.department,
      a.team_user AS team,
      ${roleTier} AS role_tier,
      ec.position,
      CASE WHEN ec.weekly_working_hours IS NULL OR ec.weekly_working_hours = 0
           THEN NULL
           ELSE CAST(ec.weekly_working_hours / 40.0 AS NUMERIC(5, 3))
      END AS fte,
      a.is_real_employee,
      a.is_project_contributing,
      a.is_multi_org,
      ${effEnd} AS effective_end_date
    FROM employee_current ec
    LEFT JOIN employee_annotation a USING (employee_id)
    WHERE ${whereClause}
    ORDER BY a.team_user NULLS LAST, ec.last_name, ec.first_name
  `);

  const rows = result.rows as unknown as Array<
    Omit<EmployeeListRow, "contract_end_date"> & {
      effective_end_date: string | null;
    }
  >;

  return rows.map<EmployeeListRow>((r) => ({
    employee_id: r.employee_id,
    first_name: r.first_name,
    last_name: r.last_name,
    status: r.status,
    department: r.department,
    team: r.team,
    role_tier: r.role_tier,
    position: r.position,
    fte: r.fte === null ? null : Number(r.fte),
    is_real_employee: r.is_real_employee,
    is_project_contributing: r.is_project_contributing,
    is_multi_org: r.is_multi_org,
    contract_end_date:
      r.effective_end_date && !r.effective_end_date.startsWith("9999")
        ? r.effective_end_date
        : null,
  }));
}

/** Distinct curated team names for the filter dropdown. Same data the
 * `/api/employees/teams` route returns. */
export async function listEmployeeTeams(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT team_user
    FROM employee_annotation
    WHERE team_user IS NOT NULL
    ORDER BY team_user
  `);
  return (result.rows as Array<{ team_user: string }>).map((r) => r.team_user);
}
