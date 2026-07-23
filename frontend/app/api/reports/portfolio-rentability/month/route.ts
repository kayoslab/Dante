import Decimal from "decimal.js";
import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { fmt } from "@/lib/db/_monthly-helpers";
import {
  computeMonthlyBenchTotals,
  computeProjectMonthlyRows,
  monthlyFreelancerCost,
} from "@/lib/db/queries/portfolio";

/** Per-month detail for the portfolio-rentability report's selected
 * month: revenue/cost inputs for the income-statement block,
 * per-project P&L rows, and the FP-recognition lifetime numbers.
 *
 * Returns only the fields the report client reads — this route was
 * split off from the legacy `/api/portfolio/monthly` once it stopped
 * powering the old Home card. Bench head counts + the bench
 * consultants list + per-segment totals are gone; the utilization
 * report owns the bench detail and the income-statement derivation
 * lives in the client. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "portfolio_rentability_month", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(
        `month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`,
      );
    }

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

    await audit(ctx, {
      action: "view_portfolio_rentability_month",
      target_type: "report",
      target_id: "portfolio_rentability",
    });

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
  });
}
