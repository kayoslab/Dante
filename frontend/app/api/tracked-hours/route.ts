import type { NextRequest } from "next/server";

import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { buildTrackedHoursMonth } from "@/lib/reports/tracked-hours";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "tracked_hours", "expensive");
    const { searchParams } = new URL(req.url);
    const monthParam = searchParams.get("month") ?? "";
    const team = searchParams.get("team");

    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthParam)})`);
    }
    const month_start = `${monthParam}-01`;
    if (isNaN(new Date(month_start).getTime())) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthParam)})`);
    }

    // Body lives in lib/reports/tracked-hours.ts so the server-side
    // prefetch in app/reports/time/page.tsx ships the same wire object.
    return buildTrackedHoursMonth({ month: monthParam, team });
  });
}
