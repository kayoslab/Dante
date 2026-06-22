import type { NextRequest } from "next/server";

import { getEmployeeAworkLinks } from "@/lib/db/queries/employee";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

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

    const rows = await getEmployeeAworkLinks(employee_id);

    await audit(ctx, {
      action: "view_employee_awork_links",
      target_type: "employee",
      target_id: employee_id,
    });

    return rows;
  });
}
