import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }

    const result = await db.execute(sql`
      SELECT effective_from, amount_value, amount_currency, interval,
             category, type_name, weekly_working_hours
      FROM compensation_event
      WHERE employee_id = ${employee_id}
      ORDER BY effective_from ASC NULLS LAST, category, type_name
    `);

    return (result.rows as Array<Record<string, unknown>>).map((r) => ({
      effective_from: r.effective_from,
      amount_value:
        r.amount_value === null || r.amount_value === undefined
          ? null
          : Number(r.amount_value).toFixed(2),
      amount_currency: r.amount_currency,
      interval: r.interval,
      category: r.category,
      type_name: r.type_name,
      weekly_working_hours:
        r.weekly_working_hours === null || r.weekly_working_hours === undefined
          ? null
          : Number(r.weekly_working_hours).toFixed(2),
    }));
  });
}
