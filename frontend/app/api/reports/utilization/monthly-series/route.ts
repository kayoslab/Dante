import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { firstOfMonth } from "@/lib/db/_monthly-helpers";
import { buildUtilizationSeries } from "@/lib/reports/utilization";

/** Utilization series across a month range — trailing actuals + forecast.
 *
 * Body lives in `lib/reports/utilization.ts` (`buildUtilizationSeries`)
 * so the report page can prefetch the same payload server-side. This
 * route keeps auth, rate-limit, param validation, and audit.
 *
 * Cost: months × employees with a few sub-queries each. At ~40
 * employees × 16 months (12 back + current + 3 ahead) it's heavy —
 * tagged `expensive` rate-limit and capped at 24 months. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "utilization_series", "expensive");

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

    const result = await buildUtilizationSeries(from_raw, to_raw);

    await audit(ctx, {
      action: "view_utilization_series",
      target_type: "report",
      target_id: "utilization",
    });

    return result;
  });
}
