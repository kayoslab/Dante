import type { NextRequest } from "next/server";

import { getCustomerAworkLink } from "@/lib/db/queries/customer";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const customer_id = Number(rawId);
    if (!Number.isInteger(customer_id)) {
      throw Validation(`invalid customer id: ${rawId}`);
    }
    return await getCustomerAworkLink(customer_id);
  });
}
