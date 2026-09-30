import type { NextRequest } from "next/server";

import {
  NotFound,
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { findTeamBySlug } from "@/lib/db/queries/team";
import { buildTeamMonth } from "@/lib/reports/team";
import { teamSlug } from "@/lib/team-slug";

/** Per-month detail block for the team detail page: header KPIs + roster
 * rows + project mix. Drives the month-nav scrubber on
 * `/teams/[slug]`. The chart and the forecast section render in their
 * own components anchored at "now" — those don't depend on this
 * route. Body lives in lib/reports/team.ts so the server-side prefetch
 * in app/teams/[slug]/page.tsx ships the same wire object. */
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

    const result = await buildTeamMonth(team_name, monthRaw);

    await audit(ctx, {
      action: "view_team_month",
      target_type: "team",
      target_id: team_name,
    });

    return result;
  });
}
