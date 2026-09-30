import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { firstOfMonth } from "@/lib/db/_monthly-helpers";
import { buildPortfolioRentabilitySeries } from "@/lib/reports/portfolio-rentability";

/** Portfolio P&L series across a month range (trailing actuals + forecast).
 *
 * Body lives in `lib/reports/portfolio-rentability.ts`
 * (`buildPortfolioRentabilitySeries`) so the report page can prefetch
 * the same payload server-side. This route keeps auth, rate-limit,
 * param validation, and audit.
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

    const result = await buildPortfolioRentabilitySeries(from_raw, to_raw);

    await audit(ctx, {
      action: "view_portfolio_rentability_series",
      target_type: "report",
      target_id: "portfolio_rentability",
    });

    return result;
  });
}
