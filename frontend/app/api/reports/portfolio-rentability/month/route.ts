import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { buildPortfolioRentabilityMonth } from "@/lib/reports/portfolio-rentability";

/** Per-month detail for the portfolio-rentability report's selected
 * month: revenue/cost inputs for the income-statement block,
 * per-project P&L rows, and the FP-recognition lifetime numbers.
 *
 * Body lives in `lib/reports/portfolio-rentability.ts`
 * (`buildPortfolioRentabilityMonth`) so the report page can prefetch
 * the same payload server-side. This route keeps auth, rate-limit,
 * param validation, and audit. */
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

    const result = await buildPortfolioRentabilityMonth(monthRaw);

    await audit(ctx, {
      action: "view_portfolio_rentability_month",
      target_type: "report",
      target_id: "portfolio_rentability",
    });

    return result;
  });
}
