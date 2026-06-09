import type { NextRequest } from "next/server";

import { getEmployeeDetail } from "@/lib/db/queries/employee";
import { audit } from "@/lib/auth/audit";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }
    const detail = await getEmployeeDetail(employee_id);
    if (!detail) throw NotFound(`employee not found: ${employee_id}`);

    await audit(ctx, {
      action: "view_employee_detail",
      target_type: "employee",
      target_id: employee_id,
    });

    return detail;
  });
}
