import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import {
  computeCustomerConcentration,
  computeCustomerMonthlyAggregates,
  listEndingProjectsByCustomer,
} from "@/lib/db/queries/customer-rentability";

const ENDING_WINDOW_DAYS = 90;

/** Selected-month detail for the customer-rentability report: full
 * Pareto table, concentration KPIs, and the "concentration at risk"
 * panel (customers whose biggest project ends in the next 90 days). */
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

    const today = new Date().toISOString().slice(0, 10);
    const to = addDays(today, ENDING_WINDOW_DAYS);

    const [aggregates, ending_projects] = await Promise.all([
      computeCustomerMonthlyAggregates(monthRaw),
      listEndingProjectsByCustomer(today, to),
    ]);

    const concentration = computeCustomerConcentration(aggregates);

    // Sort customers by margin DESC for Pareto display. Negative-margin
    // customers sink to the bottom (still visible — they're the
    // money-pit signal).
    const customers = [...aggregates].sort(
      (a, b) => Number(b.margin) - Number(a.margin),
    );

    await audit(ctx, {
      action: "view_customer_rentability_month",
      target_type: "report",
      target_id: "customer_rentability",
    });

    return {
      month: monthRaw,
      ending_window: { from: today, to },
      customers,
      concentration,
      ending_projects,
    };
  });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
