import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import {
  NotFound,
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { addMonths, firstOfMonth, lastOfMonth } from "@/lib/db/_monthly-helpers";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";
import { findTeamBySlug, getTeamMemberIds } from "@/lib/db/queries/team";
import { teamSlug } from "@/lib/team-slug";

/** Monthly P&L series for a team across the requested window.
 *
 * Returns one point per month. Each point sums per-employee
 * `computeEmployeeMonthly` across the team's members (eligibility
 * same as the bench query: active, real, project-contributing,
 * contract overlaps the month). Forecast months are months whose
 * `month_start` is in the future — the engine projects from existing
 * assignment rows, no special-cased pipeline data.
 *
 * Cost: members × months queries. At 7 members × 10 months (~6 back +
 * current + 3 ahead) it's ~70 calls. Acceptable client-side (the
 * page itself already rendered) but enforces an `expensive` per-user
 * rate limit so an attacker can't loop. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "team_monthly_series", "expensive");

    const { slug } = await params;
    const team_name = await findTeamBySlug(slug, teamSlug);
    if (!team_name) throw NotFound(`team not found: ${slug}`);

    const { searchParams } = new URL(req.url);
    const from_raw = searchParams.get("from_month") ?? "";
    const to_raw = searchParams.get("to_month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(from_raw) || !/^\d{4}-\d{2}$/.test(to_raw)) {
      throw Validation("from_month and to_month must be YYYY-MM");
    }
    const from_month = firstOfMonth(`${from_raw}-01`);
    const to_month = firstOfMonth(`${to_raw}-01`);
    if (to_month < from_month) {
      throw Validation("to_month must be >= from_month");
    }
    // Sanity cap: 24 months. Anything longer is almost certainly a
    // request bug; lets us bound the worst-case query count.
    const months: string[] = [];
    let cur = from_month;
    while (cur <= to_month && months.length < 24) {
      months.push(cur.slice(0, 7));
      cur = addMonths(cur, 1);
    }

    const member_ids = await getTeamMemberIds(
      team_name,
      from_month,
      lastOfMonth(to_month),
    );

    // For each month, compute per-employee monthly P&L in parallel,
    // then sum into one team point.
    const today = new Date().toISOString().slice(0, 10);
    const points = await Promise.all(
      months.map(async (monthYm) => {
        const per = await Promise.all(
          member_ids.map((id) => computeEmployeeMonthly(id, monthYm)),
        );
        let revenue = 0;
        let cost = 0;
        let util = 0;
        let n = 0;
        for (const d of per) {
          if (!d) continue;
          revenue += Number(d.revenue ?? "0");
          cost += Number(d.monthly_cost_full ?? "0");
          if (d.under_contract) {
            util += Number(d.utilization_pct ?? "0");
            n += 1;
          }
        }
        const margin = revenue - cost;
        const margin_pct = revenue > 0 ? (margin / revenue) * 100 : null;
        const utilization = n > 0 ? util / n : null;
        const month_start = `${monthYm}-01`;
        const is_forecast = month_start > today;
        return {
          month: monthYm,
          revenue: revenue.toFixed(2),
          cost: cost.toFixed(2),
          margin: margin.toFixed(2),
          margin_pct: margin_pct === null ? null : margin_pct.toFixed(2),
          utilization_pct:
            utilization === null ? null : utilization.toFixed(4),
          is_forecast,
        };
      }),
    );

    await audit(ctx, {
      action: "view_team_monthly_series",
      target_type: "team",
      target_id: team_name,
    });

    return { team: team_name, points };
  });
}
