import type { NextRequest } from "next/server";

import { Validation, handle } from "@/lib/api/_route-helpers";
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
    await requireApiProjectAccess(project_id);
    return getFreelancerHoursForProject(project_id);
  });
}
