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
    const customer_id = Number(rawId);
    if (!Number.isInteger(customer_id)) {
      throw Validation(`invalid customer id: ${rawId}`);
    }
    const r = await db.execute(sql`
      SELECT aco.awork_company_id, aco.name, aco.is_external,
             aco.projects_count, aco.projects_in_progress_count
      FROM awork_company_link link
      JOIN awork_company aco
        ON aco.awork_company_id = link.awork_company_id
      WHERE link.customer_id = ${customer_id}
    `);
    const row = (r.rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    return {
      awork_company_id: row.awork_company_id,
      name: row.name,
      is_external: row.is_external,
      projects_count: row.projects_count,
      projects_in_progress_count: row.projects_in_progress_count,
      mapped_to_customer_id: customer_id,
      mapped_to_customer_name: null,
    };
  });
}
