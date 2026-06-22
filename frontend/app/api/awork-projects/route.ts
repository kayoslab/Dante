import type { NextRequest } from "next/server";

import { boundedSearchQuery, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { listAworkProjects } from "@/lib/db/queries/awork";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const mappedRaw = searchParams.get("mapped");
    const mapped =
      mappedRaw === null ? null : mappedRaw.toLowerCase() === "true";
    const q = boundedSearchQuery(searchParams.get("q"));

    return await listAworkProjects({ mapped, q });
  });
}
