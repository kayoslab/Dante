import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden, notFound } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import {
  findTeamBySlug,
  getTeamMembers,
  getTeamUpcomingAssignments,
} from "@/lib/db/queries/team";
import { hasRole, requireSession } from "@/lib/auth/session";
import { isoMonthOf, shiftMonth } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";
import { buildTeamMonth, buildTeamMonthlySeries } from "@/lib/reports/team";
import { teamSlug } from "@/lib/team-slug";

import { TeamDetailClient } from "./team-detail-client";

// "Going partial" forecast threshold: an allocation drop of this much
// or more (in percentage points) before the forecast window's end
// flags the row. 25% = drop from 100% → 75% or 80% → 55%.
const PARTIAL_DROP_THRESHOLD_PCT = 25;

// Chart window — must match MONTHS_BACK / MONTHS_FORWARD in
// components/team/team-monthly-pl-chart.tsx (keep in sync).
const CHART_MONTHS_BACK = 6;
const CHART_MONTHS_FORWARD = 3;

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

  const today = new Date().toISOString().slice(0, 10);
  const forecastEnd = (() => {
    // 90 days forward, rounded to month end so the forecast section's
    // window covers three full months. Matches the chart's
    // MONTHS_FORWARD constant.
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 4);
    d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  })();

  // Prefetch what the client tree asks for on its first render so the
  // first paint ships populated KPIs / roster / chart instead of skeletons:
  //  - `useTeamMonth(slug, month)`  → ["team", slug, "month", month]
  //  - `useTeamMonthlySeries(slug, from, to)` (team-monthly-pl-chart)
  //      → ["team", slug, "monthly-series", from, to]
  // Keys must match the hooks in lib/api/team-series.ts exactly (keep in
  // sync). A server/browser timezone mismatch around midnight on the
  // month boundary just makes the prefetch miss and the client fetch as
  // before — harmless.
  const month = isoMonthOf(new Date());
  const from = shiftMonth(month, -CHART_MONTHS_BACK);
  const to = shiftMonth(month, CHART_MONTHS_FORWARD);
  const qc = getQueryClient();

  // Pre-fetch the data that does NOT move with the month selector:
  //  - `members.length` for the header headcount line (initial paint);
  //  - `upcoming` for the always-anchored-at-now forecast section.
  // Everything else (KPI grid, roster, project mix) is fetched
  // client-side from `/api/teams/[slug]/month` on month change.
  const [members, upcoming] = await Promise.all([
    getTeamMembers(team_name, today),
    getTeamUpcomingAssignments(team_name, today, forecastEnd),
    qc.prefetchQuery({
      queryKey: ["team", slug, "month", month],
      queryFn: () => buildTeamMonth(team_name, month),
    }),
    qc.prefetchQuery({
      queryKey: ["team", slug, "monthly-series", from, to],
      queryFn: () => buildTeamMonthlySeries(team_name, from, to),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <TeamDetailClient
        slug={slug}
        team_name={team_name}
        n_members_initial={members.length}
        upcoming={upcoming}
        today={today}
        forecast_end={forecastEnd}
        partial_drop_threshold_pct={PARTIAL_DROP_THRESHOLD_PCT}
      />
    </HydrationBoundary>
  );
}
