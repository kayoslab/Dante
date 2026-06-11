import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { listGrantableUsers } from "@/lib/db/queries/project-sdm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    // Only admins can see the employee list for granting SDM rights;
    // the picker is part of the admin-only grant UI.
    await requireApiSession({ minRole: "admin" });
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    return listGrantableUsers(project_id);
  });
}
