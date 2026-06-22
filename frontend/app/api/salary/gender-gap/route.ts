import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import {
  getGenderGap,
  type GenderGapBasis,
  type GenderGapGrouping,
} from "@/lib/db/queries/salary";

const VALID_GROUPING = new Set<GenderGapGrouping>(["tier", "team"]);
const VALID_BASIS = new Set<GenderGapBasis>(["fix", "total"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "salary_gender_gap", "expensive");
    const { searchParams } = new URL(req.url);
    const grouping = (searchParams.get("grouping") ?? "tier") as GenderGapGrouping;
    const basis = (searchParams.get("basis") ?? "fix") as GenderGapBasis;
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation("grouping must be tier|team");
    }
    if (!VALID_BASIS.has(basis)) {
      throw Validation("basis must be fix|total");
    }
    await audit(ctx, {
      action: "view_gender_gap",
      target_type: "salary_insights",
      target_id: `${grouping}/${basis}`,
    });

    return getGenderGap(grouping, basis);
  });
}
