import { eq, sql } from "drizzle-orm";

import { db } from "../client";

export type Rate = {
  profile: string;
  valid_from: string;
  daily_rate_eur: string | null;
};

export type ProjectAssignment = {
  assignment_id: number;
  kind: string;
  who_name: string | null;
  employee_id: number | null;
  freelancer_id: number | null;
  profile: string | null;
  allocation_pct: string | null;
  start_date: string | null;
  end_date: string | null;
  daily_rate_override_eur: string | null;
  daily_cost_override_eur: string | null;
  effective_profile: string | null;
  effective_daily_rate_eur: string | null;
  rate_source: string | null;
  notes: string | null;
};

export type ProjectEconomics = {
  n_current_employees: number;
  n_current_freelancers: number;
  total_allocation_now: string | null;
  monthly_revenue_now: string | null;
  monthly_internal_cost_now: string | null;
  monthly_external_cost_now: string | null;
  monthly_cost_now: string | null;
  monthly_gross_margin_now: string | null;
  monthly_gross_margin_pct: string | null;
};

export type ProjectDetail = {
  project_id: number;
  customer_id: number;
  customer_name: string;
  framework_id: number | null;
  framework_name: string | null;
  name: string;
  billing_model: string;
  agreed_amount_eur: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  rates: Rate[];
  framework_rates: Rate[];
  assignments: ProjectAssignment[];
  economics: ProjectEconomics;
};

export async function getProjectDetail(
  project_id: number,
): Promise<ProjectDetail | null> {
  const detailRes = await db.execute(sql`
    SELECT p.project_id, p.customer_id, c.name AS customer_name,
           p.framework_id,
           (SELECT name FROM framework_agreement WHERE framework_id = p.framework_id) AS framework_name,
           p.name, p.billing_model, p.agreed_amount_eur,
           p.planned_start_date, p.planned_end_date, p.status, p.notes,
           p.created_at
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.project_id = ${project_id}
  `);
  const row = (detailRes.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const ratesRes = await db.execute(sql`
    SELECT profile, valid_from, daily_rate_eur FROM project_rate
    WHERE project_id = ${project_id}
    ORDER BY profile, valid_from
  `);
  const rates = (ratesRes.rows as Array<Record<string, unknown>>).map((r) => ({
    profile: r.profile as string,
    valid_from: r.valid_from as string,
    daily_rate_eur:
      r.daily_rate_eur === null || r.daily_rate_eur === undefined
        ? null
        : String(r.daily_rate_eur),
  }));

  let framework_rates: Rate[] = [];
  if (row.framework_id !== null && row.framework_id !== undefined) {
    const frRes = await db.execute(sql`
      SELECT profile, valid_from, daily_rate_eur FROM framework_rate
      WHERE framework_id = ${row.framework_id as number}
      ORDER BY profile, valid_from
    `);
    framework_rates = (frRes.rows as Array<Record<string, unknown>>).map((r) => ({
      profile: r.profile as string,
      valid_from: r.valid_from as string,
      daily_rate_eur:
        r.daily_rate_eur === null || r.daily_rate_eur === undefined
          ? null
          : String(r.daily_rate_eur),
    }));
  }

  const asnRes = await db.execute(sql`
    SELECT a.assignment_id,
           CASE WHEN a.employee_id IS NOT NULL THEN 'employee' ELSE 'freelancer' END AS kind,
           COALESCE(ec.first_name || ' ' || ec.last_name, f.name) AS who_name,
           a.employee_id, a.freelancer_id,
           a.profile, a.allocation_pct,
           a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur,
           aer.effective_profile, aer.effective_daily_rate_eur, aer.rate_source,
           a.notes
    FROM assignment a
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    LEFT JOIN freelancer f ON f.freelancer_id = a.freelancer_id
    LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
    WHERE a.project_id = ${project_id}
    ORDER BY (a.end_date IS NULL) DESC, a.start_date DESC
  `);
  const assignments = (asnRes.rows as Array<Record<string, unknown>>).map((r) => ({
    assignment_id: r.assignment_id as number,
    kind: r.kind as string,
    who_name: r.who_name as string | null,
    employee_id: (r.employee_id as number | null) ?? null,
    freelancer_id: (r.freelancer_id as number | null) ?? null,
    profile: r.profile as string | null,
    allocation_pct:
      r.allocation_pct === null || r.allocation_pct === undefined
        ? null
        : String(r.allocation_pct),
    start_date: r.start_date as string | null,
    end_date: r.end_date as string | null,
    daily_rate_override_eur:
      r.daily_rate_override_eur === null || r.daily_rate_override_eur === undefined
        ? null
        : String(r.daily_rate_override_eur),
    daily_cost_override_eur:
      r.daily_cost_override_eur === null || r.daily_cost_override_eur === undefined
        ? null
        : String(r.daily_cost_override_eur),
    effective_profile: r.effective_profile as string | null,
    effective_daily_rate_eur:
      r.effective_daily_rate_eur === null || r.effective_daily_rate_eur === undefined
        ? null
        : String(r.effective_daily_rate_eur),
    rate_source: r.rate_source as string | null,
    notes: r.notes as string | null,
  }));

  const econRes = await db.execute(sql`
    SELECT n_current_employees, n_current_freelancers, total_allocation_now,
           monthly_revenue_now, monthly_internal_cost_now, monthly_external_cost_now,
           monthly_cost_now, monthly_gross_margin_now
    FROM project_summary WHERE project_id = ${project_id}
  `);
  const e = (econRes.rows as Array<Record<string, unknown>>)[0];
  const sNum = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  let economics: ProjectEconomics;
  if (!e) {
    economics = {
      n_current_employees: 0,
      n_current_freelancers: 0,
      total_allocation_now: null,
      monthly_revenue_now: null,
      monthly_internal_cost_now: null,
      monthly_external_cost_now: null,
      monthly_cost_now: null,
      monthly_gross_margin_now: null,
      monthly_gross_margin_pct: null,
    };
  } else {
    const rev = e.monthly_revenue_now;
    const margin = e.monthly_gross_margin_now;
    let margin_pct: string | null = null;
    if (
      rev !== null &&
      rev !== undefined &&
      margin !== null &&
      margin !== undefined
    ) {
      const revF = Number(rev);
      if (revF > 0) {
        margin_pct = ((Number(margin) / revF) * 100).toFixed(2);
      }
    }
    economics = {
      n_current_employees: Number(e.n_current_employees ?? 0),
      n_current_freelancers: Number(e.n_current_freelancers ?? 0),
      total_allocation_now: sNum(e.total_allocation_now),
      monthly_revenue_now: sNum(e.monthly_revenue_now),
      monthly_internal_cost_now: sNum(e.monthly_internal_cost_now),
      monthly_external_cost_now: sNum(e.monthly_external_cost_now),
      monthly_cost_now: sNum(e.monthly_cost_now),
      monthly_gross_margin_now: sNum(e.monthly_gross_margin_now),
      monthly_gross_margin_pct: margin_pct,
    };
  }

  return {
    project_id: row.project_id as number,
    customer_id: row.customer_id as number,
    customer_name: row.customer_name as string,
    framework_id: (row.framework_id as number | null) ?? null,
    framework_name: (row.framework_name as string | null) ?? null,
    name: row.name as string,
    billing_model: row.billing_model as string,
    agreed_amount_eur:
      row.agreed_amount_eur === null || row.agreed_amount_eur === undefined
        ? null
        : String(row.agreed_amount_eur),
    planned_start_date: row.planned_start_date as string | null,
    planned_end_date: row.planned_end_date as string | null,
    status: row.status as string,
    notes: row.notes as string | null,
    created_at: new Date(row.created_at as Date | string).toISOString(),
    rates,
    framework_rates,
    assignments,
    economics,
  };
}
