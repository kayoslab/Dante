import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { computeForecast } from "@/lib/db/queries/forecast";

/** Forecast report (manager-only): planned vs actual for the current month,
 * assumed utilization at the current realization ratio, and the planned
 * pipeline for the next two months. Always "current + 2" — no month param. */
export async function GET() {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "forecast", "expensive");

    const today = new Date().toISOString().slice(0, 10);
    const report = await computeForecast(today);

    await audit(ctx, {
      action: "view_report_forecast",
      target_type: "report",
      target_id: "forecast",
    });

    return report;
  });
}
