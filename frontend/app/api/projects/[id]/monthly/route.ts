import type { NextRequest } from "next/server";

import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";
import { computeProjectMonthly } from "@/lib/db/queries/project-monthly";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    const ctx = await requireApiProjectAccess(project_id);
    enforceRateLimit(ctx, "project_monthly", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }

    const result = await computeProjectMonthly(project_id, monthRaw);
    if (result === null) throw NotFound(`project not found: ${project_id}`);
    return result;
  });
}
