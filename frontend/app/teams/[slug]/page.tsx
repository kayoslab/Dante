import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TeamMonthlyPLChart } from "@/components/team/team-monthly-pl-chart";
import { TeamForecastSection } from "@/components/team/team-forecast-section";
import { audit } from "@/lib/auth/audit";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";
import {
  findTeamBySlug,
  getTeamMembers,
  getTeamUpcomingAssignments,
} from "@/lib/db/queries/team";
import { teamSlug } from "@/lib/team-slug";
import { hasRole, requireSession } from "@/lib/auth/session";
import { formatEUR } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// "Going partial" forecast threshold: an allocation drop of this much
// or more (in percentage points) before the forecast window's end
// flags the row. 25% = drop from 100% → 75% or 80% → 55%.
const PARTIAL_DROP_THRESHOLD_PCT = 25;

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

type RosterRow = {
  employee_id: number;
  who_name: string;
  role_tier: string | null;
  utilization_pct: number; // 0–1
  monthly_cost: number; // EUR
  monthly_revenue: number; // EUR
  monthly_margin: number; // EUR
  primary_assignment: AssignmentSummary | null;
  bench_since_days: number | null;
  ends_soon: { project: string; date: string } | null;
};

type ProjectMixRow = {
  project_id: number;
  project_name: string;
  revenue: number;
  cost: number;
  pct_of_revenue: number;
};

function currentMonthYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  const { slug } = await params;
  const team_name = await findTeamBySlug(slug, teamSlug);
  if (!team_name) notFound();

  await audit(ctx, {
    action: "view_team_detail",
    target_type: "team",
    target_id: team_name,
  });

  const monthYm = currentMonthYm();
  const month_start = `${monthYm}-01`;
  const today = todayIso();
  const forecastEnd = (() => {
    // 90 days forward, rounded to month end so the chart's forecast
    // window covers three full months.
    const d = new Date(`${month_start}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 4);
    d.setUTCDate(0); // last day of month-3
    return d.toISOString().slice(0, 10);
  })();

  const members = await getTeamMembers(team_name, today);

  // Current-month per-employee P&L. Parallel because each row is an
  // independent DB query — ~7 queries for a typical team finishes in
  // ~500ms total instead of ~3.5s serialised.
  const perMember = await Promise.all(
    members.map((m) => computeEmployeeMonthly(m.employee_id, monthYm)),
  );

  // Upcoming assignments power both the "ends soon" annotation on the
  // roster and the forecast section's lists. Single query → both uses.
  const upcoming = await getTeamUpcomingAssignments(
    team_name,
    today,
    forecastEnd,
  );

  // -- Aggregate header KPIs --------------------------------------
  let totalRevenue = 0;
  let totalCost = 0;
  let totalUtil = 0;
  let nUtilCounted = 0;
  let nFullyUtilized = 0;
  let nPartialBench = 0;
  let nFullBench = 0;
  let benchEur = 0;

  // -- Roster rows -----------------------------------------------
  const roster: RosterRow[] = [];

  // Project mix accumulator: project_id → {name, revenue, cost}.
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
      totalUtil += util;
      nUtilCounted += 1;
      if (util >= 1.0) nFullyUtilized += 1;
      else if (util > 0) nPartialBench += 1;
      else nFullBench += 1;
    }
    if (util < 1.0) {
      benchEur += cost * (1 - util);
    }

    // Project mix: each assignment row contributes its revenue + cost.
    const assignments = (data.assignments as Array<Record<string, unknown>>) ?? [];
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

    // Roster row: pick the assignment with the highest allocation as
    // the "primary" for display; the inline annotation calls out a
    // soon-ending assignment if any.
    const primary = pickPrimaryAssignment(assignments);
    const ends_soon = pickEndingSoon(
      upcoming.filter((u) => u.employee_id === m.employee_id),
      today,
    );

    // "Bench since X days" — if utilization is 0 today, count back
    // until the most recent assignment end, capped at hire_date.
    let bench_since_days: number | null = null;
    if (util === 0) {
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
      utilization_pct: util,
      monthly_cost: cost,
      monthly_revenue: revenue,
      monthly_margin: margin,
      primary_assignment: primary,
      bench_since_days,
      ends_soon,
    });
  }

  // Sort roster: utilization ASC so the bench rows sit on top, ties
  // broken by name for stability.
  roster.sort((a, b) => {
    if (a.utilization_pct !== b.utilization_pct) {
      return a.utilization_pct - b.utilization_pct;
    }
    return a.who_name.localeCompare(b.who_name);
  });

  const totalMargin = totalRevenue - totalCost;
  const marginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : null;
  const avgUtil = nUtilCounted > 0 ? totalUtil / nUtilCounted : null;

  // Project mix — every project the team touched this month, sorted
  // by revenue contribution DESC. Full list (no Top-N bucketing) so
  // a long tail of small projects is visible too; the bar chart makes
  // the dominant ones obvious.
  const projectMix: ProjectMixRow[] = Array.from(projectAgg, ([id, agg]) => ({
    project_id: id,
    project_name: agg.name,
    revenue: agg.revenue,
    cost: agg.cost,
    pct_of_revenue:
      totalRevenue > 0 ? (agg.revenue / totalRevenue) * 100 : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/teams"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Teams
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {team_name}
        </h1>
        <div className="mt-1 text-sm text-muted-foreground">
          {members.length} {members.length === 1 ? "employee" : "employees"}
        </div>
      </div>

      {/* Current-month KPIs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">This month</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
            <Kpi label="Revenue" value={formatEUR(totalRevenue.toFixed(2))} />
            <Kpi label="Cost" value={formatEUR(totalCost.toFixed(2))} />
            <Kpi
              label="Margin"
              value={formatEUR(totalMargin.toFixed(2))}
              tone={
                totalMargin < 0
                  ? "text-red-700"
                  : totalMargin < totalCost * 0.1
                    ? "text-amber-700"
                    : "text-emerald-700"
              }
            />
            <Kpi
              label="Margin %"
              value={marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
              tone={
                marginPct === null
                  ? undefined
                  : marginPct < 0
                    ? "text-red-700"
                    : marginPct < 10
                      ? "text-amber-700"
                      : "text-emerald-700"
              }
            />
            <Kpi
              label="Utilization"
              value={avgUtil === null ? "—" : `${(avgUtil * 100).toFixed(0)}%`}
              tone={
                avgUtil === null
                  ? undefined
                  : avgUtil < 0.75
                    ? "text-amber-700"
                    : "text-emerald-700"
              }
            />
          </div>
          <div className="mt-4 grid gap-4 grid-cols-2 md:grid-cols-3">
            <Kpi label="Bench EUR" value={formatEUR(benchEur.toFixed(2))} />
            <Kpi
              label="Bench heads"
              value={
                <>
                  {nFullBench}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    fully · {nPartialBench} partial
                  </span>
                </>
              }
            />
            <Kpi
              label="Fully utilized"
              value={
                <>
                  {nFullyUtilized}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    consultants
                  </span>
                </>
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Roster */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Roster</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {roster.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No active members on file for {team_name}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Role</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Current project
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Util %</th>
                    <th className="px-3 py-2 text-right font-medium">Cost</th>
                    <th className="px-3 py-2 text-right font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {roster.map((r) => {
                    const utilTone =
                      r.utilization_pct === 0
                        ? "text-red-700"
                        : r.utilization_pct < 1
                          ? "text-amber-700"
                          : "text-emerald-700";
                    const marginTone =
                      r.monthly_margin < 0
                        ? "text-red-700"
                        : "text-emerald-700";
                    return (
                      <tr key={r.employee_id} className="hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <Link
                            href={`/employees/${r.employee_id}`}
                            className="hover:underline"
                          >
                            {r.who_name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {r.role_tier ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {r.bench_since_days !== null ? (
                            <span className="text-xs text-muted-foreground italic">
                              (bench since {r.bench_since_days}d)
                            </span>
                          ) : r.primary_assignment?.project_name ? (
                            <>
                              <Link
                                href={`/projects/${r.primary_assignment.project_id}`}
                                className="hover:underline"
                              >
                                {r.primary_assignment.project_name}
                              </Link>
                              {r.ends_soon && (
                                <span className="ml-2 text-xs text-amber-700">
                                  ↳ ends {r.ends_soon.date}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            utilTone,
                          )}
                        >
                          {(r.utilization_pct * 100).toFixed(0)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatEUR(r.monthly_cost.toFixed(2))}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            marginTone,
                          )}
                        >
                          {r.monthly_margin >= 0 ? "+" : ""}
                          {formatEUR(r.monthly_margin.toFixed(2))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Monthly P&L chart (history + current + forecast) */}
      <TeamMonthlyPLChart slug={slug} />

      {/* Forecast: ending soon + going partial */}
      <TeamForecastSection
        upcoming={upcoming}
        today={today}
        forecastEnd={forecastEnd}
        partialThresholdPct={PARTIAL_DROP_THRESHOLD_PCT}
      />

      {/* Project mix */}
      {projectMix.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Project mix (this month)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-3 border-b pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <div className="min-w-0 flex-1">Project</div>
                <div className="hidden flex-1 sm:block" aria-hidden />
                <div className="w-12 text-right">% rev</div>
                <div className="w-24 text-right">Revenue</div>
              </div>
              {projectMix.map((p) => (
                <div
                  key={p.project_id}
                  className="flex items-center gap-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/projects/${p.project_id}`}
                      className="hover:underline"
                    >
                      {p.project_name}
                    </Link>
                  </div>
                  <div className="hidden flex-1 sm:block">
                    <div className="relative h-2 overflow-hidden rounded bg-muted">
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/70"
                        style={{ width: `${p.pct_of_revenue}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                    {p.pct_of_revenue.toFixed(0)}%
                  </div>
                  <div className="w-24 text-right tabular-nums">
                    {formatEUR(p.revenue.toFixed(2))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums",
          tone,
        )}
      >
        {value}
      </div>
    </div>
  );
}

function pickPrimaryAssignment(
  assignments: Array<Record<string, unknown>>,
): AssignmentSummary | null {
  if (assignments.length === 0) return null;
  // Pick the assignment with the highest allocation_pct. Ties → first.
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
    start_date: string | null;
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
    start_date: string | null;
  }>,
  hire_date: string | null,
  today: string,
): number | null {
  // Find the most recent assignment that ended before today.
  const mine = upcoming
    .filter((u) => u.employee_id === employee_id)
    .filter((u) => u.end_date !== null && u.end_date < today)
    .sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""));
  const lastEnd = mine[0]?.end_date ?? hire_date;
  if (!lastEnd) return null;
  return daysBetween(lastEnd, today);
}
