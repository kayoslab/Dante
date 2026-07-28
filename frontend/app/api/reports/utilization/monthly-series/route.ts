import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import {
  addMonths,
  firstOfMonth,
  mapWithConcurrency,
} from "@/lib/db/_monthly-helpers";
import {
  computeUtilizationForMonth,
  listForecastDrivers,
} from "@/lib/db/queries/utilization";

/** Utilization series across a month range — trailing actuals + forecast.
 *
 * For each month: every eligible employee gets a single per-month load
 * (prorated loaded cost, weighted allocation, unallocated cost),
 * grouped twice — once by team and once by role tier. Drives the
 * trend chart, the KPI tiles, and the per-row sparklines.
 *
 * Forecast drivers (projects ending + hires starting) are bundled with
 * the same window so the chart's forecast tail has explanatory context
 * without a second round-trip.
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
    const months: string[] = [];
    let cur = from_month;
    while (cur <= to_month && months.length < 24) {
      months.push(cur.slice(0, 7));
      cur = addMonths(cur, 1);
    }

    const today = new Date().toISOString().slice(0, 10);

    // Forecast-drivers window — the months whose start is strictly in
    // the future. If none (caller didn't request any forecast months),
    // the window collapses to empty and the lists come back empty.
    const future_months = months.filter((m) => `${m}-01` > today);
    let from_drv = today;
    let to_drv = today;
    if (future_months.length > 0) {
      from_drv = `${future_months[0]}-01`;
      // Last day of the last forecast month
      const last = future_months[future_months.length - 1];
      to_drv = firstOfMonth(`${last}-01`);
      to_drv = addMonths(to_drv, 1);
      // addMonths returns first of next month; subtract one day for "last day"
      const d = new Date(`${to_drv}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      to_drv = d.toISOString().slice(0, 10);
    }

    const [points, forecast_drivers] = await Promise.all([
      // Bounded month fan-out: each month is internally parallel already;
      // running all 16 at once would just flood the pg pool queue.
      mapWithConcurrency(months, 4, (monthYm) =>
        computeUtilizationForMonth(monthYm, today),
      ),
      future_months.length > 0
        ? listForecastDrivers(from_drv, to_drv)
        : Promise.resolve({
            from_date: from_drv,
            to_date: to_drv,
            projects_ending: [],
            hires_starting: [],
          }),
    ]);

    await audit(ctx, {
      action: "view_utilization_series",
      target_type: "report",
      target_id: "utilization",
    });

    return { points, forecast_drivers };
  });
}
