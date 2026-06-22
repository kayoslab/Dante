/** Read helpers backing `estimateAssignmentAction`.
 *
 * `lib/actions/assignment.ts` runs a what-if margin computation for the
 * assignment edit dialog. The math itself (FTE prorate, burden multiplier,
 * billing-model branch) stays in the action; everything that touches the
 * database lives here.
 *
 * `getBurdenFactor()` lives here rather than `lib/db/queries/setting.ts`
 * because the only caller is this estimate path — splitting it across
 * two files would just add an import for no extra reuse. If a second
 * caller appears, move it.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import {
  customer,
  employeeCurrent,
  freelancer,
  project,
  setting,
} from "../schema";

export async function getBurdenFactor(): Promise<number> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, "burden_factor"));
  return row ? Number(row.value) : 1.0;
}

export type EmployeeCompForCost = {
  fix_salary: string | null;
  fix_salary_interval: string | null;
  hourly_salary: string | null;
  // `weekly_working_hours` is `doublePrecision()` in the schema, so
  // Drizzle returns `number`. Other comp fields are `numeric()` /
  // string per the AGENTS.md "money stays as string" rule.
  weekly_working_hours: number | null;
} | null;

export async function getEmployeeCompForCost(
  employee_id: number,
): Promise<EmployeeCompForCost> {
  const [row] = await db
    .select({
      fix_salary: employeeCurrent.fix_salary,
      fix_salary_interval: employeeCurrent.fix_salary_interval,
      hourly_salary: employeeCurrent.hourly_salary,
      weekly_working_hours: employeeCurrent.weekly_working_hours,
    })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  return row ?? null;
}

export async function getEmployeeWeeklyHours(
  employee_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ weekly_working_hours: employeeCurrent.weekly_working_hours })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  if (!row || row.weekly_working_hours === null) return null;
  return Number(row.weekly_working_hours);
}

/** Best-guess profile for an employee when the caller didn't override.
 * Comes from the `employee_role_tier` view — see migration 0003. */
export async function getEmployeeRoleTier(
  employee_id: number,
): Promise<string | null> {
  const r = await db.execute(sql`
    SELECT role_tier FROM employee_role_tier WHERE employee_id = ${employee_id}
  `);
  const row = (r.rows as Array<{ role_tier: string | null }>)[0];
  return row?.role_tier ?? null;
}

export type FreelancerForCost = {
  name: string;
  daily_cost_eur: string | null;
} | null;

export async function getFreelancerForCost(
  freelancer_id: number,
): Promise<FreelancerForCost> {
  const [row] = await db
    .select({
      name: freelancer.name,
      daily_cost_eur: freelancer.daily_cost_eur,
    })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  if (!row) return null;
  return { name: row.name, daily_cost_eur: row.daily_cost_eur };
}

export type EstimateProjectContext = {
  billing_model: string;
  framework_id: number | null;
  agreed_amount_eur: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  project_name: string;
  customer_name: string;
} | null;

export async function getEstimateProjectContext(
  project_id: number,
): Promise<EstimateProjectContext> {
  const [row] = await db
    .select({
      billing_model: project.billing_model,
      framework_id: project.framework_id,
      agreed_amount_eur: project.agreed_amount_eur,
      planned_start_date: project.planned_start_date,
      planned_end_date: project.planned_end_date,
      project_name: project.name,
      customer_name: customer.name,
    })
    .from(project)
    .innerJoin(customer, eq(customer.customer_id, project.customer_id))
    .where(eq(project.project_id, project_id));
  return row ?? null;
}

/** Resolve the daily rate for an assignment by profile + as-of date.
 * Project-rate overrides framework-rate; both fall back to "unset" if
 * no row covers `as_of`. */
export async function resolveAssignmentRate(opts: {
  project_id: number;
  framework_id: number | null;
  profile: string | null;
  as_of: string;
}): Promise<{ rate: number | null; source: string }> {
  if (!opts.profile) return { rate: null, source: "unset" };
  const pr = await db.execute(sql`
    SELECT daily_rate_eur FROM project_rate
    WHERE project_id = ${opts.project_id}
      AND profile = ${opts.profile}
      AND valid_from <= ${opts.as_of}::date
    ORDER BY valid_from DESC LIMIT 1
  `);
  const prRow = (pr.rows as Array<{ daily_rate_eur: string }>)[0];
  if (prRow) {
    return { rate: Number(prRow.daily_rate_eur), source: "project_rate" };
  }
  if (opts.framework_id !== null) {
    const fr = await db.execute(sql`
      SELECT daily_rate_eur FROM framework_rate
      WHERE framework_id = ${opts.framework_id}
        AND profile = ${opts.profile}
        AND valid_from <= ${opts.as_of}::date
      ORDER BY valid_from DESC LIMIT 1
    `);
    const frRow = (fr.rows as Array<{ daily_rate_eur: string }>)[0];
    if (frRow) {
      return { rate: Number(frRow.daily_rate_eur), source: "framework_rate" };
    }
  }
  return { rate: null, source: "unset" };
}
