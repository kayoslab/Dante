import type { NextRequest } from "next/server";

import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";
import { getProjectLoggedTimeSummary } from "@/lib/db/queries/project";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    const ctx = await requireApiProjectAccess(project_id);
    enforceRateLimit(ctx, "logged_time_summary", "expensive");

    const summary = await getProjectLoggedTimeSummary(project_id);
    if (!summary) throw NotFound(`project not found: ${project_id}`);
    return summary;
  });
}
