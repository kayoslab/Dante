import { forbidden, notFound } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import {
  findTeamBySlug,
  getTeamMembers,
  getTeamUpcomingAssignments,
} from "@/lib/db/queries/team";
import { hasRole, requireSession } from "@/lib/auth/session";
import { teamSlug } from "@/lib/team-slug";

import { TeamDetailClient } from "./team-detail-client";

export const dynamic = "force-dynamic";

// "Going partial" forecast threshold: an allocation drop of this much
// or more (in percentage points) before the forecast window's end
// flags the row. 25% = drop from 100% → 75% or 80% → 55%.
const PARTIAL_DROP_THRESHOLD_PCT = 25;

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

  // Pre-fetch the data that does NOT move with the month selector:
  //  - `members.length` for the header headcount line (initial paint);
  //  - `upcoming` for the always-anchored-at-now forecast section.
  // Everything else (KPI grid, roster, project mix) is fetched
  // client-side from `/api/teams/[slug]/month` on month change.
  const [members, upcoming] = await Promise.all([
    getTeamMembers(team_name, today),
    getTeamUpcomingAssignments(team_name, today, forecastEnd),
  ]);

  return (
    <TeamDetailClient
      slug={slug}
      team_name={team_name}
      n_members_initial={members.length}
      upcoming={upcoming}
      today={today}
      forecast_end={forecastEnd}
      partial_drop_threshold_pct={PARTIAL_DROP_THRESHOLD_PCT}
    />
  );
}
