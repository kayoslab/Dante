import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { buildCustomerRentabilityMonth } from "@/lib/reports/customer-rentability";

/** Selected-month detail for the customer-rentability report: full
 * Pareto table, concentration KPIs, and the "concentration at risk"
 * panel (customers whose biggest project ends in the next 90 days).
 *
 * Body lives in `lib/reports/customer-rentability.ts`
 * (`buildCustomerRentabilityMonth`) so the report page can prefetch
 * the same payload server-side. This route keeps auth, rate-limit,
 * param validation, and audit. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "customer_rentability_month", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(
        `month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`,
      );
    }

    const result = await buildCustomerRentabilityMonth(monthRaw);

    await audit(ctx, {
      action: "view_customer_rentability_month",
      target_type: "report",
      target_id: "customer_rentability",
    });

    return result;
  });
}
