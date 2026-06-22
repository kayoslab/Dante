import type { NextRequest } from "next/server";

import { handle, requireApiSession, Validation } from "@/lib/api/_route-helpers";
import { listProjects } from "@/lib/db/queries/project";

// Mirrors the CHECK constraint in migration 0004
// (`project.status IN ('active', 'completed', 'cancelled')`). Reject
// any other value at the route boundary so an attacker can't probe
// for valid statuses by cycling through arbitrary values.
const ALLOWED_STATUS = new Set(["active", "completed", "cancelled"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    if (status !== null && !ALLOWED_STATUS.has(status)) {
      throw Validation(`invalid status: ${status}`);
    }
    const customerIdRaw = searchParams.get("customer_id");
    const customer_id = customerIdRaw === null ? null : Number(customerIdRaw);

    return listProjects({ status, customer_id });
  });
}
