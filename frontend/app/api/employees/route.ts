import type { NextRequest } from "next/server";

import { listEmployees } from "@/lib/db/queries/employee-list";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession();
    const { searchParams } = new URL(req.url);
    const includeExcludedParam = searchParams.get("include_excluded");
    return listEmployees({
      q: searchParams.get("q") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      team: searchParams.get("team") ?? undefined,
      include_excluded:
        includeExcludedParam === null
          ? true
          : includeExcludedParam.toLowerCase() !== "false",
    });
  });
}
