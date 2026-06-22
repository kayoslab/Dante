import type { NextRequest } from "next/server";

import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import { listAworkUsers } from "@/lib/db/queries/awork";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const linkedRaw = searchParams.get("linked");
    const linked =
      linkedRaw === null ? null : linkedRaw.toLowerCase() === "true";
    const includeArchived =
      (searchParams.get("include_archived") ?? "false").toLowerCase() === "true";

    return await listAworkUsers({ linked, includeArchived });
  });
}
