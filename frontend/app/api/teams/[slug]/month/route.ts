import type { NextRequest } from "next/server";

import {
  NotFound,
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { lastOfMonth } from "@/lib/db/_monthly-helpers";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";
import {
  findTeamBySlug,
  getTeamMembers,
  getTeamUpcomingAssignments,
} from "@/lib/db/queries/team";
import { teamSlug } from "@/lib/team-slug";

type AssignmentSummary = {
  assignment_id: number | null;
  project_id: number | null;
  project_name: string | null;
  customer_name: string | null;
  allocation_pct: string | null;
  end_date: string | null;
  revenue: string | null;
  cost: string | null;
};

/** Per-month detail block for the team detail page: header KPIs + roster
 * rows + project mix. Drives the month-nav scrubber on
 * `/teams/[slug]`. The chart and the forecast section render in their
 * own components anchored at "now" — those don't depend on this
 * route. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "team_month", "expensive");

    const { slug } = await params;
    const team_name = await findTeamBySlug(slug, teamSlug);
    if (!team_name) throw NotFound(`team not found: ${slug}`);

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(
        `month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`,
      );
    }
    const month_end = lastOfMonth(`${monthRaw}-01`);
    const today = new Date().toISOString().slice(0, 10);
    const todayMonth = today.slice(0, 7);
    const is_current_month = monthRaw === todayMonth;

    const members = await getTeamMembers(team_name, month_end);
    const perMember = await Promise.all(
      members.map((m) => computeEmployeeMonthly(m.employee_id, monthRaw)),
    );

    // "Bench since" / "ends soon" only make sense for the current
    // month. For historical / forecast scrubs those columns drop out.
    const upcoming = is_current_month
      ? await getTeamUpcomingAssignments(team_name, today, addDays(today, 90))
      : [];

    let totalRevenue = 0;
    let totalCost = 0;
    let totalUtilSum = 0;
    let nUtilCounted = 0;
    let nFullyUtilized = 0;
    let nPartialBench = 0;
    let nFullBench = 0;
    let benchEur = 0;

    type RosterRow = {
      employee_id: number;
      who_name: string;
      role_tier: string | null;
      utilization_pct: string; // 0-1
      monthly_cost: string;
      monthly_revenue: string;
      monthly_margin: string;
      primary_assignment: AssignmentSummary | null;
      bench_since_days: number | null;
      ends_soon: { project: string; date: string } | null;
    };

    const roster: RosterRow[] = [];
    const projectAgg = new Map<
      number,
      { name: string; revenue: number; cost: number }
    >();

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const data = perMember[i];
      if (!data) continue;

      const revenue = Number(data.revenue ?? "0");
      const cost = Number(data.monthly_cost_full ?? "0");
      const margin = revenue - cost;
      const util = Number(data.utilization_pct ?? "0");

      totalRevenue += revenue;
      totalCost += cost;
      if (data.under_contract) {
        totalUtilSum += util;
        nUtilCounted += 1;
        if (util >= 1) nFullyUtilized += 1;
        else if (util > 0) nPartialBench += 1;
        else nFullBench += 1;
      }
      if (util < 1) {
        benchEur += cost * (1 - util);
      }

      const assignments =
        (data.assignments as Array<Record<string, unknown>>) ?? [];
      for (const a of assignments) {
        const project_id = a.project_id as number | undefined;
        const project_name = a.project_name as string | undefined;
        if (project_id === undefined || project_name === undefined) continue;
        const agg = projectAgg.get(project_id) ?? {
          name: project_name,
          revenue: 0,
          cost: 0,
        };
        agg.revenue += Number(a.revenue ?? "0");
        agg.cost += Number(a.cost ?? "0");
        projectAgg.set(project_id, agg);
      }

      const primary = pickPrimaryAssignment(assignments);
      const ends_soon = is_current_month
        ? pickEndingSoon(
            upcoming.filter((u) => u.employee_id === m.employee_id),
            today,
          )
        : null;

      let bench_since_days: number | null = null;
      if (is_current_month && util === 0) {
        bench_since_days = computeBenchDays(
          m.employee_id,
          upcoming,
          m.hire_date,
          today,
        );
      }

      roster.push({
        employee_id: m.employee_id,
        who_name: m.who_name || `Employee #${m.employee_id}`,
        role_tier: m.role_tier,
        utilization_pct: util.toFixed(4),
        monthly_cost: cost.toFixed(2),
        monthly_revenue: revenue.toFixed(2),
        monthly_margin: margin.toFixed(2),
        primary_assignment: primary,
        bench_since_days,
        ends_soon,
      });
    }

    roster.sort((a, b) => {
      const ua = Number(a.utilization_pct);
      const ub = Number(b.utilization_pct);
      if (ua !== ub) return ua - ub;
      return a.who_name.localeCompare(b.who_name);
    });

    const totalMargin = totalRevenue - totalCost;
    const marginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : null;
    const avgUtil = nUtilCounted > 0 ? totalUtilSum / nUtilCounted : null;

    const project_mix = Array.from(projectAgg, ([id, agg]) => ({
      project_id: id,
      project_name: agg.name,
      revenue: agg.revenue.toFixed(2),
      cost: agg.cost.toFixed(2),
      pct_of_revenue:
        totalRevenue > 0
          ? ((agg.revenue / totalRevenue) * 100).toFixed(2)
          : "0.00",
    })).sort((a, b) => Number(b.revenue) - Number(a.revenue));

    await audit(ctx, {
      action: "view_team_month",
      target_type: "team",
      target_id: team_name,
    });

    return {
      month: monthRaw,
      is_current_month,
      n_members: members.length,
      kpis: {
        revenue: totalRevenue.toFixed(2),
        cost: totalCost.toFixed(2),
        margin: totalMargin.toFixed(2),
        margin_pct: marginPct === null ? null : marginPct.toFixed(2),
        avg_util_pct: avgUtil === null ? null : avgUtil.toFixed(4),
        bench_eur: benchEur.toFixed(2),
        n_full_bench: nFullBench,
        n_partial_bench: nPartialBench,
        n_fully_utilized: nFullyUtilized,
      },
      roster,
      project_mix,
    };
  });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pickPrimaryAssignment(
  assignments: Array<Record<string, unknown>>,
): AssignmentSummary | null {
  if (assignments.length === 0) return null;
  let best: Record<string, unknown> | null = null;
  let bestAlloc = -1;
  for (const a of assignments) {
    const alloc = Number(a.allocation_pct ?? "0");
    if (alloc > bestAlloc) {
      best = a;
      bestAlloc = alloc;
    }
  }
  if (!best) return null;
  return {
    assignment_id: (best.assignment_id as number | undefined) ?? null,
    project_id: (best.project_id as number | undefined) ?? null,
    project_name: (best.project_name as string | undefined) ?? null,
    customer_name: (best.customer_name as string | undefined) ?? null,
    allocation_pct: (best.allocation_pct as string | undefined) ?? null,
    end_date: (best.end_date as string | undefined) ?? null,
    revenue: (best.revenue as string | undefined) ?? null,
    cost: (best.cost as string | undefined) ?? null,
  };
}

function pickEndingSoon(
  upcomingForEmployee: Array<{
    project_name: string;
    end_date: string | null;
  }>,
  today: string,
): { project: string; date: string } | null {
  const candidates = upcomingForEmployee
    .filter((u) => u.end_date !== null && u.end_date >= today)
    .sort((a, b) => (a.end_date ?? "").localeCompare(b.end_date ?? ""));
  const first = candidates[0];
  if (!first || !first.end_date) return null;
  return { project: first.project_name, date: first.end_date };
}

function computeBenchDays(
  employee_id: number,
  upcoming: Array<{
    employee_id: number;
    end_date: string | null;
  }>,
  hire_date: string | null,
  today: string,
): number | null {
  const mine = upcoming
    .filter((u) => u.employee_id === employee_id)
    .filter((u) => u.end_date !== null && u.end_date < today)
    .sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""));
  const lastEnd = mine[0]?.end_date ?? hire_date;
  if (!lastEnd) return null;
  const a = new Date(`${lastEnd}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}
