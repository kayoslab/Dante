import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { buildUtilizationMonth } from "@/lib/reports/utilization";

/** Selected-month consultant lists: benched (util < 1, with "since N
 * days" duration) and overbooked (util > 1). Refetched when the user
 * scrubs to a different month; the heavier series API stays anchored
 * at "now".
 *
 * Body lives in `lib/reports/utilization.ts` (`buildUtilizationMonth`)
 * so the report page can prefetch the same payload server-side. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "utilization_month", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }
    const result = await buildUtilizationMonth(monthRaw);

    await audit(ctx, {
      action: "view_utilization_month",
      target_type: "report",
      target_id: "utilization",
    });

    return result;
  });
}
