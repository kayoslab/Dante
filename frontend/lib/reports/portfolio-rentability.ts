/** Portfolio-rentability report builders — shared by the
 * `/api/reports/portfolio-rentability/*` routes and the server-side
 * prefetch in `app/reports/portfolio-rentability/page.tsx`.
 *
 * Both callers must produce byte-identical JSON for the same arguments:
 * the page seeds React Query's cache with the builder's output under the
 * same key the client hook uses, so any divergence would show up as a
 * hydration-time refetch. Auth / rate-limit / param validation / audit
 * stay in the route; the page does its own `requireSession` + audit.
 */
import "server-only";

import Decimal from "decimal.js";

import {
  addMonths,
  firstOfMonth,
  fmt,
  mapWithConcurrency,
} from "@/lib/db/_monthly-helpers";
import {
  computeMonthlyBenchTotals,
  computePortfolioMonthlyTotals,
  computeProjectMonthlyRows,
  monthlyFreelancerCost,
} from "@/lib/db/queries/portfolio";

/** Per-month detail for the portfolio-rentability report's selected
 * month: revenue/cost inputs for the income-statement block,
 * per-project P&L rows, and the FP-recognition lifetime numbers.
 *
 * Returns only the fields the report client reads — this was split
 * off from the legacy `/api/portfolio/monthly` once it stopped
 * powering the old Home card. Bench head counts + the bench
 * consultants list + per-segment totals are gone; the utilization
 * report owns the bench detail and the income-statement derivation
 * lives in the client. */
export async function buildPortfolioRentabilityMonth(monthRaw: string) {
  const [{ rows: project_rows, agg }, bench, freelancer_cost] =
    await Promise.all([
      computeProjectMonthlyRows(monthRaw),
      computeMonthlyBenchTotals(monthRaw, { includeAllocation: true }),
      monthlyFreelancerCost(monthRaw),
    ]);

  const {
    n_tm,
    n_fp,
    tm_revenue,
    fp_recognized_revenue,
    fp_cumulative_recognized,
    fp_cumulative_cost,
    fp_n_over_budget,
    fp_has_recognition,
  } = agg;

  // FP lifetime margin — only meaningful when FP recognition has
  // fired at least once. The per-month "recognized this month"
  // numbers stay out of the response: the income statement reads
  // FP revenue from this row and the cost from loaded payroll.
  let fp_cumulative_margin: Decimal | null = null;
  let fp_cumulative_margin_pct: Decimal | null = null;
  if (fp_has_recognition) {
    fp_cumulative_margin = fp_cumulative_recognized.sub(fp_cumulative_cost);
    if (fp_cumulative_recognized.gt(0)) {
      fp_cumulative_margin_pct = fp_cumulative_margin
        .div(fp_cumulative_recognized)
        .mul(100);
    }
  }

  return {
    month: monthRaw,
    n_active_projects: project_rows.length,
    n_tm_projects: n_tm,
    n_fp_projects: n_fp,
    tm_revenue: fmt(tm_revenue, 2),
    fp_recognized_revenue: fp_has_recognition
      ? fmt(fp_recognized_revenue, 2)
      : null,
    fp_cumulative_recognized: fp_has_recognition
      ? fmt(fp_cumulative_recognized, 2)
      : null,
    fp_cumulative_cost: n_fp > 0 ? fmt(fp_cumulative_cost, 2) : null,
    fp_cumulative_margin:
      fp_cumulative_margin === null ? null : fmt(fp_cumulative_margin, 2),
    fp_cumulative_margin_pct:
      fp_cumulative_margin_pct === null
        ? null
        : fmt(fp_cumulative_margin_pct, 2),
    fp_n_over_budget,
    bench: {
      total_loaded_cost: fmt(bench.loaded, 2),
      total_unallocated_cost:
        bench.unallocated === null ? "0.00" : fmt(bench.unallocated, 2),
    },
    // Freelancer spend for the month (entered hours × daily/8). The income
    // statement must add this to loaded payroll — revenue includes
    // freelancer-delivered work, so cost must carry their invoices.
    freelancer_cost: fmt(freelancer_cost, 2),
    projects: project_rows,
  };
}

/** Portfolio P&L series across a month range (trailing actuals + forecast).
 *
 * For each month: iterates every active project and aggregates revenue
 * (T&M + FP recognized) and cost (T&M + FP this month). Months whose
 * start is in the future are flagged `is_forecast`; the engine projects
 * from committed assignment rows, no speculative pipeline.
 *
 * `from_month` / `to_month` are `YYYY-MM`; the window is capped at 24
 * months. */
export async function buildPortfolioRentabilitySeries(
  from_month_ym: string,
  to_month_ym: string,
) {
  const from_month = firstOfMonth(`${from_month_ym}-01`);
  const to_month = firstOfMonth(`${to_month_ym}-01`);
  const months: string[] = [];
  let cur = from_month;
  while (cur <= to_month && months.length < 24) {
    months.push(cur.slice(0, 7));
    cur = addMonths(cur, 1);
  }

  const today = new Date().toISOString().slice(0, 10);
  // Bounded month fan-out: each month is internally parallel already;
  // running all 16 at once would just flood the pg pool queue.
  const points = await mapWithConcurrency(months, 2, async (monthYm) => {
    const totals = await computePortfolioMonthlyTotals(monthYm);
    const month_start = `${monthYm}-01`;
    const is_forecast = month_start > today;
    return { ...totals, is_forecast };
  });

  return { points };
}
