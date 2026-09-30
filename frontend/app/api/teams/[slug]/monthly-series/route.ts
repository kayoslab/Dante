import type { NextRequest } from "next/server";

import { audit } from "@/lib/auth/audit";
import {
  NotFound,
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { firstOfMonth } from "@/lib/db/_monthly-helpers";
import { findTeamBySlug } from "@/lib/db/queries/team";
import { buildTeamMonthlySeries } from "@/lib/reports/team";
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
 * rate limit so an attacker can't loop. Body lives in
 * lib/reports/team.ts so the server-side prefetch in
 * app/teams/[slug]/page.tsx ships the same wire object. */
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
    if (firstOfMonth(`${to_raw}-01`) < firstOfMonth(`${from_raw}-01`)) {
      throw Validation("to_month must be >= from_month");
    }

    const result = await buildTeamMonthlySeries(team_name, from_raw, to_raw);

    await audit(ctx, {
      action: "view_team_monthly_series",
      target_type: "team",
      target_id: team_name,
    });

    return result;
  });
}
