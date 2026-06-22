import Decimal from "decimal.js";
import type { NextRequest } from "next/server";

import {
  absencesForEmployee,
  burdenFactor,
  employeeWeightedAllocInMonth,
  entityMonthlyCost,
  fmt,
  holidaysForYearOf,
  lastOfMonth,
  workingDaysInRange,
} from "@/lib/db/_monthly-helpers";
import {
  computeProjectMonthly,
  listActiveProjectsForPortfolio,
  listUnallocatedPayrollEmployees,
} from "@/lib/db/queries/project-monthly";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "portfolio_monthly", "expensive");
    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }
    const month_start = `${monthRaw}-01`;
    const month_end = lastOfMonth(month_start);
    const holidays = holidaysForYearOf(month_start);
    const working_days = workingDaysInRange(month_start, month_end, holidays);
    const n_wd = working_days.length;
    const burden = await burdenFactor();

    // Pull every active project; per-project monthly delegated to existing handler.
    const projects = await listActiveProjectsForPortfolio();

    let tm_revenue = new Decimal(0);
    let tm_cost = new Decimal(0);
    let fp_cost_this_month = new Decimal(0);
    let fp_agreed_amount = new Decimal(0);
    let fp_cumulative_cost = new Decimal(0);
    let fp_remaining_budget = new Decimal(0);
    let fp_has_agreed = false;
    let fp_recognized_revenue = new Decimal(0);
    let fp_cumulative_recognized = new Decimal(0);
    let fp_n_over_budget = 0;
    let fp_has_recognition = false;
    let n_tm = 0;
    let n_fp = 0;
    const project_rows: Array<Record<string, unknown>> = [];

    for (const raw of projects) {
      const project_id = raw.project_id;
      const project_name = raw.name;
      const billing_model = raw.billing_model;
      const customer_name = raw.customer_name;

      // Direct in-process call — replaced an internal `fetchSelf` of
      // `/api/projects/[id]/monthly` that re-authed and re-queried per
      // project. Same DB pool, no route-handler re-entry.
      const breakdown = await computeProjectMonthly(project_id, monthRaw);
      if (breakdown === null) continue;
      const assignments = breakdown.assignments as unknown[];
      const n_assignments = assignments.length;
      if (n_assignments === 0) continue;

      const cost = new Decimal(breakdown.cost as string);
      const revenue =
        breakdown.revenue === null || breakdown.revenue === undefined
          ? null
          : new Decimal(breakdown.revenue as string);
      const margin =
        breakdown.margin === null || breakdown.margin === undefined
          ? null
          : new Decimal(breakdown.margin as string);
      const margin_pct =
        breakdown.margin_pct === null || breakdown.margin_pct === undefined
          ? null
          : new Decimal(breakdown.margin_pct as string);

      let row_revenue = revenue;
      let row_margin = margin;
      let row_margin_pct = margin_pct;
      let recognition_method: string | null = null;
      let over_budget = false;
      const pct_complete_str = (breakdown.pct_complete as string | null) ?? null;
      if (billing_model === "fixed_price") {
        recognition_method = (breakdown.recognition_method as string | null) ?? null;
        over_budget = Boolean(breakdown.over_budget);
        if (breakdown.recognized_revenue !== null && breakdown.recognized_revenue !== undefined) {
          row_revenue = new Decimal(breakdown.recognized_revenue as string);
        }
        if (breakdown.recognized_margin !== null && breakdown.recognized_margin !== undefined) {
          row_margin = new Decimal(breakdown.recognized_margin as string);
        }
        if (breakdown.recognized_margin_pct !== null && breakdown.recognized_margin_pct !== undefined) {
          row_margin_pct = new Decimal(breakdown.recognized_margin_pct as string);
        }
      }

      project_rows.push({
        project_id,
        project_name,
        customer_name,
        billing_model,
        n_assignments,
        revenue: row_revenue === null ? null : fmt(row_revenue, 2),
        cost: fmt(cost, 2),
        margin: row_margin === null ? null : fmt(row_margin, 2),
        margin_pct: row_margin_pct === null ? null : fmt(row_margin_pct, 2),
        recognition_method,
        over_budget,
        pct_complete: pct_complete_str,
      });

      if (billing_model === "time_and_material") {
        n_tm++;
        if (revenue !== null) tm_revenue = tm_revenue.add(revenue);
        tm_cost = tm_cost.add(cost);
      } else {
        n_fp++;
        fp_cost_this_month = fp_cost_this_month.add(cost);
        if (breakdown.agreed_amount_eur !== null && breakdown.agreed_amount_eur !== undefined) {
          fp_agreed_amount = fp_agreed_amount.add(breakdown.agreed_amount_eur as string);
          fp_has_agreed = true;
        }
        if (breakdown.cumulative_cost !== null && breakdown.cumulative_cost !== undefined) {
          fp_cumulative_cost = fp_cumulative_cost.add(breakdown.cumulative_cost as string);
        }
        if (breakdown.remaining_budget !== null && breakdown.remaining_budget !== undefined) {
          fp_remaining_budget = fp_remaining_budget.add(breakdown.remaining_budget as string);
        }
        if (breakdown.recognized_revenue !== null && breakdown.recognized_revenue !== undefined) {
          fp_recognized_revenue = fp_recognized_revenue.add(breakdown.recognized_revenue as string);
          fp_has_recognition = true;
        }
        if (
          breakdown.cumulative_recognized_revenue !== null &&
          breakdown.cumulative_recognized_revenue !== undefined
        ) {
          fp_cumulative_recognized = fp_cumulative_recognized.add(
            breakdown.cumulative_recognized_revenue as string,
          );
        }
        if (breakdown.over_budget) fp_n_over_budget++;
      }
    }

    const tm_margin = n_tm > 0 ? tm_revenue.sub(tm_cost) : new Decimal(0);
    const tm_margin_pct = tm_revenue.gt(0)
      ? tm_margin.div(tm_revenue).mul(100)
      : null;

    let fp_recognized_margin: Decimal | null = null;
    let fp_recognized_margin_pct: Decimal | null = null;
    let fp_cumulative_margin: Decimal | null = null;
    let fp_cumulative_margin_pct: Decimal | null = null;
    if (fp_has_recognition) {
      fp_recognized_margin = fp_recognized_revenue.sub(fp_cost_this_month);
      if (fp_recognized_revenue.gt(0)) {
        fp_recognized_margin_pct = fp_recognized_margin
          .div(fp_recognized_revenue)
          .mul(100);
      }
      fp_cumulative_margin = fp_cumulative_recognized.sub(fp_cumulative_cost);
      if (fp_cumulative_recognized.gt(0)) {
        fp_cumulative_margin_pct = fp_cumulative_margin
          .div(fp_cumulative_recognized)
          .mul(100);
      }
    }

    const total_cost = tm_cost.add(fp_cost_this_month);
    let total_revenue: Decimal | null = null;
    let total_margin: Decimal | null = null;
    let total_margin_pct: Decimal | null = null;
    if (tm_revenue.gt(0) || fp_has_recognition) {
      total_revenue = tm_revenue.add(
        fp_has_recognition ? fp_recognized_revenue : new Decimal(0),
      );
      total_margin = total_revenue.sub(total_cost);
      if (total_revenue.gt(0)) {
        total_margin_pct = total_margin.div(total_revenue).mul(100);
      }
    }

    // Sort by cost descending (Python uses key=lambda r: -Decimal(r["cost"])).
    project_rows.sort((a, b) =>
      new Decimal(b.cost as string).cmp(new Decimal(a.cost as string)),
    );

    // Bench / unallocated payroll
    const bench = await buildUnallocatedPayroll(
      month_start,
      month_end,
      working_days,
      burden,
      holidays,
    );

    return {
      month: monthRaw,
      month_start,
      month_end,
      working_days_in_month: n_wd,
      n_active_projects: project_rows.length,
      n_tm_projects: n_tm,
      n_fp_projects: n_fp,
      tm_revenue: fmt(tm_revenue, 2),
      tm_cost: fmt(tm_cost, 2),
      tm_margin: fmt(tm_margin, 2),
      tm_margin_pct: tm_margin_pct === null ? null : fmt(tm_margin_pct, 2),
      fp_cost_this_month: n_fp > 0 ? fmt(fp_cost_this_month, 2) : null,
      fp_agreed_amount:
        n_fp > 0 && fp_has_agreed ? fmt(fp_agreed_amount, 2) : null,
      fp_cumulative_cost: n_fp > 0 ? fmt(fp_cumulative_cost, 2) : null,
      fp_remaining_budget:
        n_fp > 0 && fp_has_agreed ? fmt(fp_remaining_budget, 2) : null,
      fp_recognized_revenue: fp_has_recognition
        ? fmt(fp_recognized_revenue, 2)
        : null,
      fp_recognized_margin:
        fp_recognized_margin === null ? null : fmt(fp_recognized_margin, 2),
      fp_recognized_margin_pct:
        fp_recognized_margin_pct === null
          ? null
          : fmt(fp_recognized_margin_pct, 2),
      fp_cumulative_recognized: fp_has_recognition
        ? fmt(fp_cumulative_recognized, 2)
        : null,
      fp_cumulative_margin:
        fp_cumulative_margin === null ? null : fmt(fp_cumulative_margin, 2),
      fp_cumulative_margin_pct:
        fp_cumulative_margin_pct === null
          ? null
          : fmt(fp_cumulative_margin_pct, 2),
      fp_n_over_budget,
      total_cost: fmt(total_cost, 2),
      total_revenue: total_revenue === null ? null : fmt(total_revenue, 2),
      total_margin: total_margin === null ? null : fmt(total_margin, 2),
      total_margin_pct:
        total_margin_pct === null ? null : fmt(total_margin_pct, 2),
      bench,
      projects: project_rows,
    };
  });
}

async function buildUnallocatedPayroll(
  month_start: string,
  month_end: string,
  working_days: string[],
  burden: number,
  holidays: Map<string, string>,
): Promise<Record<string, unknown>> {
  const employees = await listUnallocatedPayrollEmployees(
    month_start,
    month_end,
  );

  const n_wd = working_days.length;
  const consultants: Array<Record<string, unknown>> = [];
  let total_loaded_cost = new Decimal(0);
  let total_unallocated_cost = new Decimal(0);
  let n_full_bench = 0;
  let n_partial_bench = 0;
  let n_fully_utilized = 0;

  for (const raw of employees) {
    const emp_id = raw.employee_id;
    const first = raw.first_name;
    const last = raw.last_name;
    const hire_date = raw.hire_date;
    const end_date = raw.employment_end_date;
    const team = raw.team;

    const { monthly_cost } = await entityMonthlyCost(emp_id, null, null, burden);
    if (monthly_cost === null) continue;

    const clip_start =
      hire_date !== null && hire_date > month_start ? hire_date : month_start;
    const clip_end =
      end_date !== null && end_date < month_end ? end_date : month_end;
    const contract_workdays =
      n_wd > 0
        ? working_days.filter((d) => d >= clip_start && d <= clip_end).length
        : 0;
    if (contract_workdays === 0) continue;
    const contract_share =
      n_wd > 0
        ? new Decimal(contract_workdays).div(n_wd)
        : new Decimal(1);
    let cost_prorated = monthly_cost.mul(contract_share);

    const [, unpaid_in_month] = await absencesForEmployee(
      emp_id,
      month_start,
      month_end,
      holidays,
    );
    let unpaid_in_contract = 0;
    for (const d of unpaid_in_month) {
      if (d >= clip_start && d <= clip_end) unpaid_in_contract++;
    }
    if (unpaid_in_contract > 0 && contract_workdays > 0) {
      const paid_share = new Decimal(
        contract_workdays - unpaid_in_contract,
      ).div(contract_workdays);
      cost_prorated = cost_prorated.mul(paid_share);
    }

    const weighted_alloc = await employeeWeightedAllocInMonth(
      emp_id,
      month_start,
      month_end,
      working_days,
    );
    const util_for_calc = Decimal.min(weighted_alloc, new Decimal(1));
    let unalloc = cost_prorated.mul(new Decimal(1).sub(util_for_calc));
    if (unalloc.lt(0)) unalloc = new Decimal(0);

    total_loaded_cost = total_loaded_cost.add(cost_prorated);
    total_unallocated_cost = total_unallocated_cost.add(unalloc);

    if (weighted_alloc.eq(0)) n_full_bench++;
    else if (weighted_alloc.lt(1)) n_partial_bench++;
    else n_fully_utilized++;

    consultants.push({
      employee_id: emp_id,
      who_name: `${first ?? ""} ${last ?? ""}`,
      team,
      monthly_cost: fmt(cost_prorated, 2),
      utilization_pct: fmt(weighted_alloc, 4),
      unallocated_cost: fmt(unalloc, 2),
    });
  }

  consultants.sort((a, b) =>
    new Decimal(b.unallocated_cost as string).cmp(
      new Decimal(a.unallocated_cost as string),
    ),
  );

  return {
    total_loaded_cost: fmt(total_loaded_cost, 2),
    total_unallocated_cost: fmt(total_unallocated_cost, 2),
    total_unallocated_pct: total_loaded_cost.gt(0)
      ? fmt(total_unallocated_cost.div(total_loaded_cost).mul(100), 2)
      : null,
    n_full_bench,
    n_partial_bench,
    n_fully_utilized,
    consultants,
  };
}
