import type { NextRequest } from "next/server";

import { getCustomerDetail } from "@/lib/db/queries/customer";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

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

    const detail = await getCustomerDetail(customer_id);
    if (!detail) throw NotFound(`customer not found: ${customer_id}`);
    return detail;
  });
}
