import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  absencesForEmployee,
  burdenFactor,
  employeeAllocSplitInMonth,
  entityMonthlyCost,
  fmt,
  fteFromWeeklyHours,
  lastOfMonth,
  mapWithConcurrency,
  monthCalendarByState,
} from "../_monthly-helpers";
import {
  type ActiveProjectRow,
  computeProjectMonthly,
  listActiveProjectsForPortfolio,
  listUnallocatedPayrollEmployees,
} from "./project-monthly";
import { getMissingFreelancerHoursMonthsByProject } from "./sdm-home";
import { cachePastMonth } from "../_report-cache";

/** Top-line portfolio P&L for a single month: revenue (T&M + FP recognized),
 * cost (loaded payroll — full company salary burden including bench),
 * margin, margin %. Used by the rentability trend chart so the chart's
 * margin line reflects "are we profitable" honestly (a quiet sales month
 * should look bad, not just look small). */
export type PortfolioMonthlyTotals = {
  month: string;
  revenue: string;
  cost: string;
  margin: string;
  margin_pct: string | null;
};

/** Monthly bench-side totals — loaded payroll across every eligible
 * employee, and (optionally) the unallocated portion. Shared between
 * the rentability trend chart (loaded only) and the per-month
 * rentability route (both numbers).
 *
 * `includeAllocation: false` skips the per-employee allocation query
 * entirely — saves one SELECT per employee per month, material on the
 * 16-month trend fan-out. */
export async function computeMonthlyBenchTotals(
  monthYm: string,
  opts: { includeAllocation?: boolean } = {},
): Promise<{ loaded: Decimal; unallocated: Decimal | null }> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);
  // Per-office state-aware calendars — same basis as available-hours and the
  // booked-capacity engine, so the bench line and the reports reconcile.
  const calFor = monthCalendarByState(month_start, month_end);
  const burden = await burdenFactor();

  const employees = await listUnallocatedPayrollEmployees(
    month_start,
    month_end,
  );
  const perEmployee = await mapLimit(
    employees,
    PROJECT_CONCURRENCY,
    async (raw) => {
      const emp_id = raw.employee_id;
      const hire_date = raw.hire_date;
      const end_date = raw.employment_end_date;
      const { monthly_cost } = await entityMonthlyCost(
        emp_id,
        null,
        null,
        burden,
        month_start,
      );
      if (monthly_cost === null) return null;

      const cal = calFor(raw.office);
      const working_days = cal.working_days;
      const n_wd = working_days.length;

      const clip_start =
        hire_date !== null && hire_date > month_start ? hire_date : month_start;
      const clip_end =
        end_date !== null && end_date < month_end ? end_date : month_end;
      const contract_workdays =
        n_wd > 0
          ? working_days.filter((d) => d >= clip_start && d <= clip_end).length
          : 0;
      if (contract_workdays === 0) return null;
      const contract_share =
        n_wd > 0 ? new Decimal(contract_workdays).div(n_wd) : new Decimal(1);
      let cost_prorated = monthly_cost.mul(contract_share);

      const [, unpaid_in_month] = await absencesForEmployee(
        emp_id,
        month_start,
        month_end,
        cal.holidays,
      );
      let unpaid_in_contract = 0;
      for (const [d, w] of unpaid_in_month) {
        if (d >= clip_start && d <= clip_end) unpaid_in_contract += w;
      }
      if (unpaid_in_contract > 0 && contract_workdays > 0) {
        const paid_share = new Decimal(
          contract_workdays - unpaid_in_contract,
        ).div(contract_workdays);
        cost_prorated = cost_prorated.mul(paid_share);
      }

      if (!opts.includeAllocation) return { cost_prorated, unalloc: null };

      // BILLABLE allocations only — matches computeEmployeeLoad in
      // utilization.ts, so the rentability bench line and the booked-capacity
      // report stay on one definition: booked = booked on billable work.
      const { billable: weighted_alloc } = await employeeAllocSplitInMonth(
        emp_id,
        month_start,
        month_end,
        working_days,
      );
      // `allocation_pct` is a fraction of full-time, so a fully-booked
      // part-timer's weighted_alloc equals their FTE. Utilization is
      // relative to FTE — not a hardcoded 1.0 — else part-timers show
      // spurious bench cost. Matches `computeEmployeeLoad` in utilization.ts.
      const fte = fteFromWeeklyHours(raw.weekly_working_hours);
      const util_clamped = Decimal.min(weighted_alloc.div(fte), new Decimal(1));
      let unalloc = cost_prorated.mul(new Decimal(1).sub(util_clamped));
      if (unalloc.lt(0)) unalloc = new Decimal(0);
      return { cost_prorated, unalloc };
    },
  );

  let loaded = new Decimal(0);
  let unallocated = new Decimal(0);
  for (const r of perEmployee) {
    if (r === null) continue;
    loaded = loaded.add(r.cost_prorated);
    if (r.unalloc !== null) unallocated = unallocated.add(r.unalloc);
  }

  return {
    loaded,
    unallocated: opts.includeAllocation ? unallocated : null,
  };
}

/** Total freelancer cost for a month: entered hours × (daily cost ÷ 8), the
 * same pay-as-they-work basis every project view uses. The portfolio cost
 * side is otherwise loaded EMPLOYEE payroll only — without this term the org
 * margin silently excluded freelancer spend while revenue included the work
 * they delivered. */
export async function monthlyFreelancerCost(monthYm: string): Promise<Decimal> {
  const r = await db.execute(sql`
    SELECT COALESCE(SUM(
      fte.hours_decimal::numeric
        * COALESCE(a.daily_cost_override_eur, f.daily_cost_eur)::numeric / 8
    ), 0) AS cost
    FROM freelancer_time_entry fte
    JOIN assignment a ON a.assignment_id = fte.assignment_id
    JOIN freelancer f ON f.freelancer_id = a.freelancer_id
    WHERE fte.year_month = ${monthYm}
  `);
  const raw = (r.rows[0] as Record<string, unknown> | undefined)?.cost;
  return raw === null || raw === undefined
    ? new Decimal(0)
    : new Decimal(raw as string);
}

const PROJECT_CONCURRENCY = 6;
const mapLimit = mapWithConcurrency;

async function sumProjectRevenue(
  projects: ActiveProjectRow[],
  monthYm: string,
): Promise<Decimal> {
  let revenue = new Decimal(0);
  const breakdowns = await mapLimit(projects, PROJECT_CONCURRENCY, (p) =>
    computeProjectMonthly(p.project_id, monthYm),
  );
  for (let i = 0; i < projects.length; i++) {
    const raw = projects[i];
    const breakdown = breakdowns[i];
    if (breakdown === null) continue;
    if (breakdown.assignments.length === 0) continue;
    if (raw.billing_model === "time_and_material") {
      if (breakdown.revenue !== null && breakdown.revenue !== undefined) {
        revenue = revenue.add(breakdown.revenue as string);
      }
    } else {
      if (
        breakdown.recognized_revenue !== null &&
        breakdown.recognized_revenue !== undefined
      ) {
        revenue = revenue.add(breakdown.recognized_revenue as string);
      }
    }
  }
  return revenue;
}

export async function computePortfolioMonthlyTotals(
  monthYm: string,
): Promise<PortfolioMonthlyTotals> {
  // Historical months are near-immutable — cache them so the 16-month
  // trend series doesn't recompute the whole portfolio on every request.
  return cachePastMonth("portfolio_totals", monthYm, () =>
    computePortfolioMonthlyTotalsUncached(monthYm),
  );
}

async function computePortfolioMonthlyTotalsUncached(
  monthYm: string,
): Promise<PortfolioMonthlyTotals> {
  const projects = await listActiveProjectsForPortfolio();

  // Revenue, loaded-payroll cost, and freelancer cost don't share state —
  // run them in parallel so each month's inner loops overlap.
  const [revenue, bench, freelancer_cost] = await Promise.all([
    sumProjectRevenue(projects, monthYm),
    computeMonthlyBenchTotals(monthYm),
    monthlyFreelancerCost(monthYm),
  ]);
  // Cost = full loaded employee payroll (incl. bench) + freelancer spend for
  // the month. Revenue includes freelancer-delivered work, so the cost side
  // must carry their invoices too or the margin overstates.
  const cost = bench.loaded.add(freelancer_cost);

  const margin = revenue.sub(cost);
  const margin_pct = revenue.gt(0) ? margin.div(revenue).mul(100) : null;

  return {
    month: monthYm,
    revenue: fmt(revenue, 2),
    cost: fmt(cost, 2),
    margin: fmt(margin, 2),
    margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
  };
}

// ---------------------------------------------------------------------------
// Per-project monthly rows — shared between the rentability month route
// (`/api/reports/portfolio-rentability/month`) and the Home project list
// route (`/api/home/projects`).
//
// Returns `rows` formatted for the wire and `agg` with raw Decimals so
// the rentability route can derive its FP-recognition lifetime numbers
// without re-parsing strings. Home only consumes `rows`.
// ---------------------------------------------------------------------------

export type ProjectMonthlyRow = {
  project_id: number;
  project_name: string;
  customer_id: number;
  customer_name: string;
  billing_model: "time_and_material" | "fixed_price";
  n_assignments: number;
  /** T&M: tracked × rate (billable). FP: recognized revenue. */
  revenue: string | null;
  /** T&M forward-looking: allocation × rate. Null for FP (recognition
   * already encodes commitment). Use to show the under-tracking gap. */
  allocation_revenue: string | null;
  cost: string;
  margin: string | null;
  margin_pct: string | null;
  recognition_method: "tracked_hours" | "timeline" | "none" | null;
  over_budget: boolean;
  pct_complete: string | null;
  /** Months since project start where a freelancer assignment was
   * active but no `freelancer_time_entry` exists. Independent of the
   * selected month — it's a project-level "to do" signal. 0 = clean. */
  n_missing_freelancer_hours_months: number;
};

export type ProjectMonthlyAggregates = {
  n_tm: number;
  n_fp: number;
  tm_revenue: Decimal;
  tm_cost: Decimal;
  fp_cost_this_month: Decimal;
  fp_agreed_amount: Decimal;
  fp_cumulative_cost: Decimal;
  fp_remaining_budget: Decimal;
  fp_recognized_revenue: Decimal;
  fp_cumulative_recognized: Decimal;
  fp_n_over_budget: number;
  fp_has_agreed: boolean;
  fp_has_recognition: boolean;
};

function emptyProjectAgg(): ProjectMonthlyAggregates {
  return {
    n_tm: 0,
    n_fp: 0,
    tm_revenue: new Decimal(0),
    tm_cost: new Decimal(0),
    fp_cost_this_month: new Decimal(0),
    fp_agreed_amount: new Decimal(0),
    fp_cumulative_cost: new Decimal(0),
    fp_remaining_budget: new Decimal(0),
    fp_recognized_revenue: new Decimal(0),
    fp_cumulative_recognized: new Decimal(0),
    fp_n_over_budget: 0,
    fp_has_agreed: false,
    fp_has_recognition: false,
  };
}

export type ProjectMonthlyRowsResult = {
  rows: ProjectMonthlyRow[];
  agg: ProjectMonthlyAggregates;
};

/** Iterate every active project (optionally filtered to a subset by id)
 * and return the per-project monthly breakdown rows plus their raw
 * Decimal aggregates. Skips projects with zero assignments in the
 * month. Sorts rows by cost descending — matches the portfolio route's
 * previous ordering. */
export async function computeProjectMonthlyRows(
  monthYm: string,
  opts: { project_ids?: number[] } = {},
): Promise<ProjectMonthlyRowsResult> {
  // Cache only the unfiltered (whole-portfolio) shape for past months —
  // it's what the customer-rentability series and the rentability month
  // route request repeatedly. Filtered calls (Home's project list) stay
  // live. Callers must not mutate the shared result.
  if (opts.project_ids === undefined) {
    return cachePastMonth("project_rows", monthYm, () =>
      computeProjectMonthlyRowsUncached(monthYm, {}),
    );
  }
  return computeProjectMonthlyRowsUncached(monthYm, opts);
}

async function computeProjectMonthlyRowsUncached(
  monthYm: string,
  opts: { project_ids?: number[] } = {},
): Promise<ProjectMonthlyRowsResult> {
  const allProjects = await listActiveProjectsForPortfolio();
  const projects =
    opts.project_ids === undefined
      ? allProjects
      : allProjects.filter((p) =>
          (opts.project_ids as number[]).includes(p.project_id),
        );

  const missingHoursMap = await getMissingFreelancerHoursMonthsByProject(
    opts.project_ids,
  );

  const rows: ProjectMonthlyRow[] = [];
  const agg = emptyProjectAgg();

  // Compute all breakdowns with bounded concurrency, then fold in order.
  const breakdowns = await mapLimit(projects, PROJECT_CONCURRENCY, (p) =>
    computeProjectMonthly(p.project_id, monthYm),
  );
  for (let i = 0; i < projects.length; i++) {
    const raw = projects[i];
    const breakdown = breakdowns[i];
    if (breakdown === null) continue;
    const assignments = breakdown.assignments;
    if (assignments.length === 0) continue;

    const cost = new Decimal(breakdown.cost as string);
    const revenue =
      breakdown.revenue === null || breakdown.revenue === undefined
        ? null
        : new Decimal(breakdown.revenue as string);
    const allocation_revenue =
      breakdown.allocation_revenue === null ||
      breakdown.allocation_revenue === undefined
        ? null
        : new Decimal(breakdown.allocation_revenue as string);
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
    let recognition_method: "tracked_hours" | "timeline" | "none" | null = null;
    let over_budget = false;
    const pct_complete = (breakdown.pct_complete as string | null) ?? null;

    if (raw.billing_model === "fixed_price") {
      const rm = (breakdown.recognition_method as string | null) ?? null;
      recognition_method =
        rm === "tracked_hours" || rm === "timeline" || rm === "none"
          ? rm
          : null;
      over_budget = Boolean(breakdown.over_budget);
      if (
        breakdown.recognized_revenue !== null &&
        breakdown.recognized_revenue !== undefined
      ) {
        row_revenue = new Decimal(breakdown.recognized_revenue as string);
      }
      if (
        breakdown.recognized_margin !== null &&
        breakdown.recognized_margin !== undefined
      ) {
        row_margin = new Decimal(breakdown.recognized_margin as string);
      }
      if (
        breakdown.recognized_margin_pct !== null &&
        breakdown.recognized_margin_pct !== undefined
      ) {
        row_margin_pct = new Decimal(breakdown.recognized_margin_pct as string);
      }
    }

    rows.push({
      project_id: raw.project_id,
      project_name: raw.name,
      customer_id: raw.customer_id,
      customer_name: raw.customer_name,
      billing_model:
        raw.billing_model === "fixed_price"
          ? "fixed_price"
          : "time_and_material",
      n_assignments: assignments.length,
      revenue: row_revenue === null ? null : fmt(row_revenue, 2),
      allocation_revenue:
        raw.billing_model === "time_and_material" && allocation_revenue !== null
          ? fmt(allocation_revenue, 2)
          : null,
      cost: fmt(cost, 2),
      margin: row_margin === null ? null : fmt(row_margin, 2),
      margin_pct: row_margin_pct === null ? null : fmt(row_margin_pct, 2),
      recognition_method,
      over_budget,
      pct_complete,
      n_missing_freelancer_hours_months:
        missingHoursMap.get(raw.project_id) ?? 0,
    });

    if (raw.billing_model === "time_and_material") {
      agg.n_tm++;
      if (revenue !== null) agg.tm_revenue = agg.tm_revenue.add(revenue);
      agg.tm_cost = agg.tm_cost.add(cost);
    } else {
      agg.n_fp++;
      agg.fp_cost_this_month = agg.fp_cost_this_month.add(cost);
      if (
        breakdown.agreed_amount_eur !== null &&
        breakdown.agreed_amount_eur !== undefined
      ) {
        agg.fp_agreed_amount = agg.fp_agreed_amount.add(
          breakdown.agreed_amount_eur as string,
        );
        agg.fp_has_agreed = true;
      }
      if (
        breakdown.cumulative_cost !== null &&
        breakdown.cumulative_cost !== undefined
      ) {
        agg.fp_cumulative_cost = agg.fp_cumulative_cost.add(
          breakdown.cumulative_cost as string,
        );
      }
      if (
        breakdown.remaining_budget !== null &&
        breakdown.remaining_budget !== undefined
      ) {
        agg.fp_remaining_budget = agg.fp_remaining_budget.add(
          breakdown.remaining_budget as string,
        );
      }
      if (
        breakdown.recognized_revenue !== null &&
        breakdown.recognized_revenue !== undefined
      ) {
        agg.fp_recognized_revenue = agg.fp_recognized_revenue.add(
          breakdown.recognized_revenue as string,
        );
        agg.fp_has_recognition = true;
      }
      if (
        breakdown.cumulative_recognized_revenue !== null &&
        breakdown.cumulative_recognized_revenue !== undefined
      ) {
        agg.fp_cumulative_recognized = agg.fp_cumulative_recognized.add(
          breakdown.cumulative_recognized_revenue as string,
        );
      }
      if (breakdown.over_budget) agg.fp_n_over_budget++;
    }
  }

  rows.sort((a, b) => new Decimal(b.cost).cmp(new Decimal(a.cost)));
  return { rows, agg };
}
