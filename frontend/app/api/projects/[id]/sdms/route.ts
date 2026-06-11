import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { listProjectSdms } from "@/lib/db/queries/project-sdm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    // SDM membership is intentionally admin-only: who manages which
    // projects is org-structure information we don't want leaked.
    await requireApiSession({ minRole: "admin" });
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    return listProjectSdms(project_id);
  });
}
