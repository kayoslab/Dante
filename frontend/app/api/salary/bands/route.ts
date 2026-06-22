import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import {
  getSalaryBands,
  type SalaryBandGrouping,
} from "@/lib/db/queries/salary";

const VALID_GROUPING = new Set<SalaryBandGrouping>([
  "tier",
  "team",
  "department",
]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const grouping = (searchParams.get("grouping") ?? "tier") as SalaryBandGrouping;
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation(`grouping must be tier|team|department`);
    }
    await audit(ctx, {
      action: "view_salary_bands",
      target_type: "salary_insights",
      target_id: grouping,
    });

    return getSalaryBands(grouping);
  });
}
