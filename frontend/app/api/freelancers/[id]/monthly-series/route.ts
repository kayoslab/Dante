import type { NextRequest } from "next/server";

import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { addMonths } from "@/lib/db/_monthly-helpers";
import { computeFreelancerMonthly } from "@/lib/db/queries/freelancer-monthly";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "freelancer_monthly_series", "expensive");
    const { id: rawId } = await params;
    const freelancer_id = Number(rawId);
    if (!Number.isInteger(freelancer_id)) {
      throw Validation(`invalid freelancer id: ${rawId}`);
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

    const today = firstOfThisMonthLocal();
    const from_month = addMonths(today, -months_back);
    const to_month = addMonths(today, months_forward);

    const points: Array<Record<string, unknown>> = [];
    let cur = from_month;
    while (cur <= to_month) {
      const monthYm = cur.slice(0, 7);
      // Direct in-process call — replaced an internal `fetchJson` of
      // `/api/freelancers/[id]/monthly` that re-authed per month.
      const b = await computeFreelancerMonthly(freelancer_id, monthYm);
      if (b === null) {
        throw NotFound(`freelancer not found: ${freelancer_id}`);
      }
      points.push({
        month: b.month,
        cost: b.cost,
        revenue: b.revenue,
        margin: b.margin,
        margin_pct: b.margin_pct,
        n_assignments: (b.assignments as unknown[]).length,
        is_forecast: cur > today,
      });
      cur = addMonths(cur, 1);
    }

    return {
      entity_kind: "freelancer",
      entity_id: freelancer_id,
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

function firstOfThisMonthLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `${y.toString().padStart(4, "0")}-${m
    .toString()
    .padStart(2, "0")}-01`;
}
