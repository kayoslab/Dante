import type { NextRequest } from "next/server";

import { listEmployees } from "@/lib/db/queries/employee-list";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession();
    const { searchParams } = new URL(req.url);
    const includeExcludedParam = searchParams.get("include_excluded");
    const rows = await listEmployees({
      q: searchParams.get("q") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      team: searchParams.get("team") ?? undefined,
      include_excluded:
        includeExcludedParam === null
          ? true
          : includeExcludedParam.toLowerCase() !== "false",
    });

    // Plain employees see a directory of colleagues but not HR-sensitive
    // detail. Contract end dates ("who's leaving"), the comp-band-ish
    // role_tier, the internal real/contributing flags, and the precise
    // position string are manager-only. First/last name, status, team,
    // department, and FTE are operationally needed for cross-team
    // awareness so they stay visible.
    const isManagerOrAdmin = ctx.role === "manager" || ctx.role === "admin";
    if (isManagerOrAdmin) return rows;
    return rows.map((r) => ({
      ...r,
      role_tier: null,
      position: null,
      is_real_employee: null,
      is_project_contributing: null,
      is_multi_org: null,
      contract_end_date: null,
    }));
  });
}
