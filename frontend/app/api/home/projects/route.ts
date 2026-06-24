import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import { computeProjectMonthlyRows } from "@/lib/db/queries/portfolio";
import { listSdmProjectIdsForUser } from "@/lib/db/queries/project-sdm";

/** Lean per-project list for the Home dashboard. Replaces the heavyweight
 * `/api/reports/portfolio-rentability/month` for Home — that one keeps powering the
 * rentability report. Scope is decided server-side from the session:
 *
 *  - `admin` / `manager`  → every active project (`scope = "all"`)
 *  - `employee` with at least one `project_sdm` grant → those projects
 *    only (`scope = "sdm"`)
 *  - any other employee → empty response (`scope = "none"`); Home
 *    falls through to the welcome view.
 *
 * Every project row carries `n_missing_freelancer_hours_months` so the
 * Home table can nag everyone (managers steer the project, SDMs own the
 * input). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession();
    enforceRateLimit(ctx, "home_projects", "expensive");

    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(
        `month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`,
      );
    }

    let scope: "all" | "sdm" | "none";
    let project_ids: number[] | undefined;
    if (ctx.role === "admin" || ctx.role === "manager") {
      scope = "all";
      project_ids = undefined;
    } else {
      const grants = await listSdmProjectIdsForUser(ctx.user_id);
      if (grants.length === 0) {
        scope = "none";
        project_ids = [];
      } else {
        scope = "sdm";
        project_ids = grants;
      }
    }

    if (scope === "none") {
      await audit(ctx, {
        action: "view_home_projects",
        target_type: "home",
        target_id: "projects",
      });
      return { month: monthRaw, scope, projects: [] };
    }

    const { rows } = await computeProjectMonthlyRows(monthRaw, { project_ids });

    await audit(ctx, {
      action: "view_home_projects",
      target_type: "home",
      target_id: "projects",
    });

    return { month: monthRaw, scope, projects: rows };
  });
}
