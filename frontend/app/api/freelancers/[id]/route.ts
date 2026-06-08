import type { NextRequest } from "next/server";

import { getFreelancerDetail } from "@/lib/db/queries/freelancer";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const freelancer_id = Number(rawId);
    if (!Number.isInteger(freelancer_id)) {
      throw Validation(`invalid freelancer id: ${rawId}`);
    }
    const detail = await getFreelancerDetail(freelancer_id);
    if (!detail) throw NotFound(`freelancer not found: ${freelancer_id}`);
    return detail;
  });
}
