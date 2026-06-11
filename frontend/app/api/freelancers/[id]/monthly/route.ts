import type { NextRequest } from "next/server";

import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { computeFreelancerMonthly } from "@/lib/db/queries/freelancer-monthly";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const freelancer_id = Number(rawId);
    if (!Number.isInteger(freelancer_id)) {
      throw Validation(`invalid freelancer id: ${rawId}`);
    }
    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }

    const result = await computeFreelancerMonthly(freelancer_id, monthRaw);
    if (result === null) throw NotFound(`freelancer not found: ${freelancer_id}`);
    return result;
  });
}
