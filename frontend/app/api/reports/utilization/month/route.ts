import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import {
  computeRealizedBillableUtilForMonth,
  listUtilizationConsultantsForMonth,
} from "@/lib/db/queries/utilization";

/** Selected-month consultant lists: benched (util < 1, with "since N
 * days" duration) and overbooked (util > 1). Refetched when the user
 * scrubs to a different month; the heavier series API stays anchored
 * at "now". */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "utilization_month", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }
    const today = new Date().toISOString().slice(0, 10);
    const detail = await listUtilizationConsultantsForMonth(monthRaw, today);
    // Realized billable utilization (tracked ÷ available) — the actuals
    // sibling of Booked %. Null for fully-future months (nothing tracked
    // yet; a 0% would be noise, not signal).
    const is_future = `${monthRaw}-01` > today;
    const billable_util = is_future
      ? null
      : await computeRealizedBillableUtilForMonth(monthRaw);

    await audit(ctx, {
      action: "view_utilization_month",
      target_type: "report",
      target_id: "utilization",
    });

    return { month: monthRaw, ...detail, billable_util };
  });
}
