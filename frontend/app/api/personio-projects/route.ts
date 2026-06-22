import type { NextRequest } from "next/server";

import { listPersonioProjects } from "@/lib/db/queries/personio";
import { boundedSearchQuery, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const mappedRaw = searchParams.get("mapped");
    const mapped =
      mappedRaw === null ? null : mappedRaw.toLowerCase() === "true";
    const q = boundedSearchQuery(searchParams.get("q"));

    return listPersonioProjects({ mapped, q });
  });
}
