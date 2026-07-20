import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { computeForecast } from "@/lib/db/queries/forecast";

/** Forecast report (manager-only): billable delivery vs available capacity for
 * the current month (utilization, bench, delivery-vs-plan) plus the planned
 * billable pipeline for the next two months. All sections derive from one
 * per-employee capacity model. Always "current + 2" — no month param. */
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
