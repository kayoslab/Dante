import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import type { OutlierGrouping } from "@/lib/db/queries/salary";
import { buildSalaryOutliers } from "@/lib/reports/salary-outliers";

const VALID_GROUPING = new Set<OutlierGrouping>(["tier", "team", "department"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const grouping = (searchParams.get("grouping") ?? "tier") as OutlierGrouping;
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation("grouping must be tier|team|department");
    }
    await audit(ctx, {
      action: "view_salary_outliers",
      target_type: "salary_insights",
      target_id: grouping,
    });

    // Detection logic lives in lib/reports/salary-outliers.ts so the
    // page-level prefetch and this route return the identical shape.
    return buildSalaryOutliers(grouping);
  });
}
