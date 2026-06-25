import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { addMonths } from "@/lib/db/_monthly-helpers";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "employee_monthly_series", "expensive");
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }
    const { searchParams } = new URL(req.url);
    const months_back = clampInt(
      searchParams.get("months_back") ?? "6",
      0,
      24,
    );
    const months_forward = clampInt(
      searchParams.get("months_forward") ?? "3",
      0,
      12,
    );

    const today = firstOfThisMonth();
    const from_month = addMonths(today, -months_back);
    const to_month = addMonths(today, months_forward);

    const points: Array<Record<string, unknown>> = [];
    let cur = from_month;
    while (cur <= to_month) {
      const monthYm = cur.slice(0, 7);
      // Direct in-process call — replaced an internal `fetchSelf` of
      // `/api/employees/[id]/monthly` that re-authed per month. The
      // series-level audit below covers the access; we deliberately
      // don't audit per-month so a 10-month view doesn't write 10 rows.
      const b = await computeEmployeeMonthly(employee_id, monthYm);
      if (b === null) {
        throw NotFound(`employee not found: ${employee_id}`);
      }
      points.push({
        month: b.month,
        under_contract: (b.under_contract as boolean | undefined) ?? true,
        monthly_cost_full: b.monthly_cost_full,
        revenue: b.revenue,
        allocation_revenue: b.allocation_revenue,
        margin: b.margin,
        margin_pct: b.margin_pct,
        utilization_pct: b.utilization_pct,
        n_assignments: (b.assignments as unknown[]).length,
        is_forecast: cur > today,
      });
      cur = addMonths(cur, 1);
    }

    await audit(ctx, {
      action: "view_employee_monthly_series",
      target_type: "employee",
      target_id: employee_id,
    });

    return {
      entity_kind: "employee",
      entity_id: employee_id,
      from_month: from_month.slice(0, 7),
      to_month: to_month.slice(0, 7),
      today_month: today.slice(0, 7),
      points,
    };
  });
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Validation(`value must be an integer in [${min}, ${max}]; got ${raw}`);
  }
  return n;
}

function firstOfThisMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `${y.toString().padStart(4, "0")}-${m
    .toString()
    .padStart(2, "0")}-01`;
}
