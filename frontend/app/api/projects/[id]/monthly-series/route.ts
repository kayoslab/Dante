import type { NextRequest } from "next/server";

import { addMonths, firstOfMonth } from "@/lib/db/_monthly-helpers";
import { computeProjectMonthly } from "@/lib/db/queries/project-monthly";
import { getProjectHeader } from "@/lib/db/queries/project";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    const ctx = await requireApiProjectAccess(project_id);
    enforceRateLimit(ctx, "project_monthly_series", "expensive");
    const { searchParams } = new URL(req.url);
    const from_raw = searchParams.get("from_month") ?? "";
    const to_raw = searchParams.get("to_month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(from_raw) || !/^\d{4}-\d{2}$/.test(to_raw)) {
      throw Validation("from_month and to_month must be YYYY-MM");
    }
    let from_month = `${from_raw}-01`;
    let to_month = `${to_raw}-01`;
    from_month = firstOfMonth(from_month);
    to_month = firstOfMonth(to_month);
    if (to_month < from_month) {
      throw Validation("to_month must be >= from_month");
    }

    const header = await getProjectHeader(project_id);
    if (!header) throw NotFound(`project not found: ${project_id}`);
    const { name: project_name, billing_model } = header;
    const agreed_amount = header.agreed_amount_eur;

    const points: Array<Record<string, unknown>> = [];
    let cur = from_month;
    while (cur <= to_month) {
      const monthYm = cur.slice(0, 7);
      // Direct in-process call — replaced an internal `fetchSelf` that
      // re-authed and re-routed per month.
      const b = await computeProjectMonthly(project_id, monthYm);
      if (b === null) {
        // Mid-series the project disappeared — bail to avoid undefined access.
        throw NotFound(`project not found mid-series: ${project_id}`);
      }
      points.push({
        month: b.month,
        working_days_in_month: b.working_days_in_month,
        revenue: b.revenue,
        cost: b.cost,
        margin: b.margin,
        margin_pct: b.margin_pct,
        cumulative_cost: b.cumulative_cost,
        remaining_budget: b.remaining_budget,
        recognized_revenue: b.recognized_revenue ?? null,
        recognized_margin: b.recognized_margin ?? null,
        cumulative_recognized_revenue: b.cumulative_recognized_revenue ?? null,
        cumulative_margin: b.cumulative_margin ?? null,
        pct_complete: b.pct_complete ?? null,
        over_budget: (b.over_budget as boolean | undefined) ?? false,
        recognition_method: b.recognition_method ?? null,
        n_assignments: (b.assignments as unknown[]).length,
        rate_unresolved_days: b.rate_unresolved_days,
        tracked_hours: b.tracked_hours ?? null,
        tracked_days: b.tracked_days ?? null,
        tracked_revenue: b.tracked_revenue ?? null,
        has_personio_mapping:
          (b.has_personio_mapping as boolean | undefined) ?? false,
      });
      cur = addMonths(cur, 1);
    }

    return {
      project_id,
      project_name,
      billing_model,
      agreed_amount_eur:
        agreed_amount === null ? null : Number(agreed_amount).toFixed(2),
      from_month: from_month.slice(0, 7),
      to_month: to_month.slice(0, 7),
      points,
    };
  });
}
