import type { NextRequest } from "next/server";

import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import { listAworkProjectsImportable } from "@/lib/db/queries/awork";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const customerIdRaw = searchParams.get("customer_id");
    const customer_id =
      customerIdRaw === null ? null : Number(customerIdRaw);

    return await listAworkProjectsImportable({ customer_id });
  });
}
