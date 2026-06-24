import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { addMonths, firstOfMonth } from "@/lib/db/_monthly-helpers";
import { computePortfolioMonthlyTotals } from "@/lib/db/queries/portfolio";

/** Portfolio P&L series across a month range (trailing actuals + forecast).
 *
 * For each month: iterates every active project and aggregates revenue
 * (T&M + FP recognized) and cost (T&M + FP this month). Months whose
 * start is in the future are flagged `is_forecast`; the engine projects
 * from committed assignment rows, no speculative pipeline.
 *
 * Cost: projects × months. At ~30 active projects × 16 months (12 back
 * + current + 3 ahead) it's ~480 inner calls, so it's tagged with the
 * `expensive` rate-limit tier and capped at 24 months. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "portfolio_rentability_series", "expensive");

    const { searchParams } = new URL(req.url);
    const from_raw = searchParams.get("from_month") ?? "";
    const to_raw = searchParams.get("to_month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(from_raw) || !/^\d{4}-\d{2}$/.test(to_raw)) {
      throw Validation("from_month and to_month must be YYYY-MM");
    }
    const from_month = firstOfMonth(`${from_raw}-01`);
    const to_month = firstOfMonth(`${to_raw}-01`);
    if (to_month < from_month) {
      throw Validation("to_month must be >= from_month");
    }
    const months: string[] = [];
    let cur = from_month;
    while (cur <= to_month && months.length < 24) {
      months.push(cur.slice(0, 7));
      cur = addMonths(cur, 1);
    }

    const today = new Date().toISOString().slice(0, 10);
    const points = await Promise.all(
      months.map(async (monthYm) => {
        const totals = await computePortfolioMonthlyTotals(monthYm);
        const month_start = `${monthYm}-01`;
        const is_forecast = month_start > today;
        return { ...totals, is_forecast };
      }),
    );

    await audit(ctx, {
      action: "view_portfolio_rentability_series",
      target_type: "report",
      target_id: "portfolio_rentability",
    });

    return { points };
  });
}
