import type { NextRequest } from "next/server";

import { getFrameworkDetail } from "@/lib/db/queries/framework";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const framework_id = Number(rawId);
    if (!Number.isInteger(framework_id)) {
      throw Validation(`invalid framework id: ${rawId}`);
    }
    const detail = await getFrameworkDetail(framework_id);
    if (!detail) throw NotFound(`framework not found: ${framework_id}`);
    return detail;
  });
}
