/** Salary insights + per-employee compensation reads.
 *
 * Source of truth for `/api/salary/*` and the per-employee salary
 * history / trajectory routes. Pure data — no audit or auth. Routes
 * audit at the request boundary. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export type SalaryBandRow = {
  group_key: string | null;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
};

export type SalaryBandGrouping = "tier" | "team" | "department";

export async function getSalaryBands(
  grouping: SalaryBandGrouping,
): Promise<SalaryBandRow[]> {
  if (grouping === "tier") {
    const r = await db.execute(sql`
      SELECT role_tier AS group_key, n, min, p25, median, p75, max
      FROM role_tier_band
      ORDER BY CASE role_tier
        WHEN 'junior' THEN 1 WHEN 'advanced' THEN 2
        WHEN 'senior' THEN 3 WHEN 'expert' THEN 4 ELSE 5 END
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      group_key: row.group_key === null ? null : String(row.group_key),
      n: Number(row.n),
      min: Number(row.min),
      p25: Number(row.p25),
      median: Number(row.median),
      p75: Number(row.p75),
      max: Number(row.max),
    }));
  }

  const groupCol =
    grouping === "team" ? sql.raw("a.team_user") : sql.raw("ec.department");

  const r = await db.execute(sql`
    WITH base AS (
      SELECT
        ${groupCol} AS group_key,
        esn.monthly_salary_fte
      FROM employee_current ec
      JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
      LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
      WHERE ec.status = 'active'
        AND esn.monthly_salary_fte IS NOT NULL
        AND ${groupCol} IS NOT NULL
        AND COALESCE(a.is_multi_org, FALSE) = FALSE
        AND COALESCE(a.is_real_employee, TRUE) = TRUE
    )
    SELECT
      group_key,
      COUNT(*) AS n,
      CAST(MIN(monthly_salary_fte) AS INTEGER) AS min,
      CAST(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p25,
      CAST(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS median,
      CAST(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p75,
      CAST(MAX(monthly_salary_fte) AS INTEGER) AS max
    FROM base
    GROUP BY group_key
    HAVING COUNT(*) >= 1
    ORDER BY group_key
  `);
  return (r.rows as Array<Record<string, unknown>>).map<SalaryBandRow>((row) => ({
    group_key: row.group_key === null ? null : String(row.group_key),
    n: Number(row.n),
    min: Number(row.min),
    p25: Number(row.p25),
    median: Number(row.median),
    p75: Number(row.p75),
    max: Number(row.max),
  }));
}

export type GenderGapGrouping = "tier" | "team";
export type GenderGapBasis = "fix" | "total";

export type GenderGapRow = {
  group_key: unknown;
  n_female: number | null;
  median_female: number | null;
  n_male: number | null;
  median_male: number | null;
  gap_pct_female_below_male: number | null;
};

export async function getGenderGap(
  grouping: GenderGapGrouping,
  basis: GenderGapBasis,
): Promise<GenderGapRow[]> {
  const view = sql.raw(
    basis === "total"
      ? grouping === "tier"
        ? "gender_pay_gap_total_by_tier"
        : "gender_pay_gap_total_by_team"
      : grouping === "tier"
        ? "gender_pay_gap_by_tier"
        : "gender_pay_gap_by_team",
  );
  const groupCol = sql.raw(grouping === "tier" ? "tier" : "team");
  const orderClause =
    grouping === "tier"
      ? sql`CASE tier
          WHEN 'junior' THEN 1 WHEN 'advanced' THEN 2
          WHEN 'senior' THEN 3 WHEN 'expert' THEN 4 ELSE 5 END`
      : sql`team`;

  const r = await db.execute(sql`
    SELECT ${groupCol} AS group_key, n_female, median_female,
           n_male, median_male, gap_pct_female_below_male
    FROM ${view}
    ORDER BY ${orderClause}
  `);

  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    group_key: row.group_key,
    n_female: row.n_female === null ? null : Number(row.n_female),
    median_female:
      row.median_female === null ? null : Number(row.median_female),
    n_male: row.n_male === null ? null : Number(row.n_male),
    median_male: row.median_male === null ? null : Number(row.median_male),
    gap_pct_female_below_male:
      row.gap_pct_female_below_male === null
        ? null
        : Number(row.gap_pct_female_below_male),
  }));
}

export type OutlierGrouping = "tier" | "team" | "department";

export type SalaryOutlierEmployeeRow = {
  employee_id: number;
  name: string;
  position: string | null;
  group_key: string;
  salary: number;
};

export async function getSalaryOutlierCandidates(
  grouping: OutlierGrouping,
): Promise<SalaryOutlierEmployeeRow[]> {
  const groupCol =
    grouping === "tier"
      ? sql.raw("rt.role_tier")
      : grouping === "team"
        ? sql.raw("a.team_user")
        : sql.raw("ec.department");

  const joinRoleTier =
    grouping === "tier"
      ? sql`JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id`
      : sql``;

  const r = await db.execute(sql`
    SELECT
      ec.employee_id,
      ec.first_name,
      ec.last_name,
      ec.position,
      ${groupCol} AS group_key,
      esn.monthly_salary_fte AS salary
    FROM employee_current ec
    JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
    LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
    ${joinRoleTier}
    WHERE ec.status = 'active'
      AND esn.monthly_salary_fte IS NOT NULL
      AND ${groupCol} IS NOT NULL
      AND COALESCE(a.is_multi_org, FALSE) = FALSE
      AND COALESCE(a.is_real_employee, TRUE) = TRUE
  `);

  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: Number(row.employee_id),
    name: [row.first_name, row.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || `#${row.employee_id}`,
    position: row.position === null ? null : String(row.position),
    group_key: String(row.group_key),
    salary: Number(row.salary),
  }));
}

export type SalaryHistoryRow = {
  effective_from: unknown;
  amount_value: string | null;
  amount_currency: unknown;
  interval: unknown;
  category: unknown;
  type_name: unknown;
  weekly_working_hours: string | null;
};

export async function getSalaryHistory(
  employee_id: number,
): Promise<SalaryHistoryRow[]> {
  const result = await db.execute(sql`
    SELECT effective_from, amount_value, amount_currency, interval,
           category, type_name, weekly_working_hours
    FROM compensation_event
    WHERE employee_id = ${employee_id}
    ORDER BY effective_from ASC NULLS LAST, category, type_name
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    effective_from: r.effective_from,
    amount_value:
      r.amount_value === null || r.amount_value === undefined
        ? null
        : Number(r.amount_value).toFixed(2),
    amount_currency: r.amount_currency,
    interval: r.interval,
    category: r.category,
    type_name: r.type_name,
    weekly_working_hours:
      r.weekly_working_hours === null || r.weekly_working_hours === undefined
        ? null
        : Number(r.weekly_working_hours).toFixed(2),
  }));
}

export type SalaryTrajectoryRow = {
  effective_date: unknown;
  annual_eur: string | null;
  previous_annual_eur: string | null;
  delta_eur: string | null;
  delta_pct: string | null;
  source: unknown;
};

export async function getSalaryTrajectory(
  employee_id: number,
): Promise<SalaryTrajectoryRow[]> {
  const result = await db.execute(sql`
    SELECT effective_date, new_annual_eur, old_annual_eur, source
    FROM salary_change_event
    WHERE employee_id = ${employee_id}
      AND new_annual_eur > 1000
    ORDER BY effective_date ASC, event_id ASC
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const newV = r.new_annual_eur === null || r.new_annual_eur === undefined
      ? null
      : Number(r.new_annual_eur);
    const oldV = r.old_annual_eur === null || r.old_annual_eur === undefined
      ? null
      : Number(r.old_annual_eur);
    let delta_eur: number | null = null;
    let delta_pct: number | null = null;
    if (newV !== null && oldV !== null && oldV > 0) {
      delta_eur = newV - oldV;
      delta_pct = (delta_eur / oldV) * 100;
    }
    return {
      effective_date: r.effective_date,
      annual_eur: newV === null ? null : newV.toFixed(2),
      previous_annual_eur: oldV === null ? null : oldV.toFixed(2),
      delta_eur: delta_eur === null ? null : delta_eur.toFixed(2),
      delta_pct: delta_pct === null ? null : delta_pct.toFixed(2),
      source: r.source,
    };
  });
}
