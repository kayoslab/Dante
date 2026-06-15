import type { NextRequest } from "next/server";

import { Validation, handle } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";
import { getFreelancerHoursForProject } from "@/lib/db/queries/freelancer-hours";

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
    enforceRateLimit(ctx, "freelancer_hours", "expensive");
    return getFreelancerHoursForProject(project_id);
  });
}
