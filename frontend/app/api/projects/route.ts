import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const customerIdRaw = searchParams.get("customer_id");
    const customer_id = customerIdRaw === null ? null : Number(customerIdRaw);

    const conds: ReturnType<typeof sql>[] = [];
    if (status) conds.push(sql`p.status = ${status}`);
    if (customer_id !== null && Number.isInteger(customer_id)) {
      conds.push(sql`p.customer_id = ${customer_id}`);
    }
    const where =
      conds.length === 0 ? sql`1=1` : sql.join(conds, sql` AND `);

    const result = await db.execute(sql`
      SELECT p.project_id, p.name, p.customer_id, c.name AS customer_name,
             p.billing_model, p.status, p.framework_id,
             (SELECT name FROM framework_agreement WHERE framework_id = p.framework_id) AS framework_name,
             p.planned_start_date, p.planned_end_date
      FROM project p
      JOIN customer c ON c.customer_id = p.customer_id
      WHERE ${where}
      ORDER BY c.name, p.name
    `);

    return (result.rows as Array<Record<string, unknown>>).map((r) => ({
      project_id: r.project_id,
      name: r.name,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      billing_model: r.billing_model,
      status: r.status,
      framework_id: r.framework_id,
      framework_name: r.framework_name,
      planned_start_date: r.planned_start_date,
      planned_end_date: r.planned_end_date,
    }));
  });
}
