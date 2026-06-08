import type { NextRequest } from "next/server";

import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { addMonths } from "@/lib/db/_monthly-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
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
      const b = await fetchSelf(
        req,
        `/api/employees/${employee_id}/monthly?month=${monthYm}`,
      );
      points.push({
        month: b.month,
        under_contract: (b.under_contract as boolean | undefined) ?? true,
        monthly_cost_full: b.monthly_cost_full,
        revenue: b.revenue,
        margin: b.margin,
        margin_pct: b.margin_pct,
        utilization_pct: b.utilization_pct,
        n_assignments: (b.assignments as unknown[]).length,
        is_forecast: cur > today,
      });
      cur = addMonths(cur, 1);
    }

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

async function fetchSelf(
  req: NextRequest,
  path: string,
): Promise<Record<string, unknown>> {
  const origin = new URL(req.url).origin;
  // Forward the session cookie so the Proxy doesn't gate internal aggregation
  // fetches back to /login. Server-to-server fetch has no cookie by default.
  const cookie = req.headers.get("cookie") ?? "";
  const res = await fetch(origin + path, { headers: { cookie } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
