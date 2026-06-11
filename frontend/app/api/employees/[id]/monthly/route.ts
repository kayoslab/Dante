import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }
    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }

    const result = await computeEmployeeMonthly(employee_id, monthRaw);
    if (result === null) throw NotFound(`employee not found: ${employee_id}`);

    await audit(ctx, {
      action: "view_employee_monthly",
      target_type: "employee",
      target_id: employee_id,
    });

    return result;
  });
}
