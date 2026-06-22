import type { NextRequest } from "next/server";

import { getEmployeeAllocations } from "@/lib/db/queries/employee";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "employee_allocations", "expensive");
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }

    const rows = await getEmployeeAllocations(employee_id);

    await audit(ctx, {
      action: "view_employee_allocations",
      target_type: "employee",
      target_id: employee_id,
    });

    return rows;
  });
}
