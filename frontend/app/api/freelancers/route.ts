import type { NextRequest } from "next/server";

import { listFreelancers } from "@/lib/db/queries/freelancer-list";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    return listFreelancers({
      status: searchParams.get("status") ?? undefined,
    });
  });
}
