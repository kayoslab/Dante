import type { NextRequest } from "next/server";

import { getProjectDetail } from "@/lib/db/queries/project";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    const detail = await getProjectDetail(project_id);
    if (!detail) throw NotFound(`project not found: ${project_id}`);
    return detail;
  });
}
