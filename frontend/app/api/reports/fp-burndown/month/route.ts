import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { computeFpBurndownForMonth } from "@/lib/db/queries/fp-burndown";

/** Selected-month FP burn-down state: per-project agreed vs tracked vs
 * planned, sorted by risk. `as_of` is `min(today, last day of month)` —
 * the burn-down is past-and-present only, never forecasts into the
 * future. The per-project compute fan-out is heavy (tracked hours +
 * cumulative cost + recognition per project), so tagged `expensive`. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "fp_burndown_month", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(
        `month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const data = await computeFpBurndownForMonth(monthRaw, today);

    await audit(ctx, {
      action: "view_fp_burndown_month",
      target_type: "report",
      target_id: "fp_burndown",
    });

    return data;
  });
}
