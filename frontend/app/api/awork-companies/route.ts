import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { boundedSearchQuery, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const mappedRaw = searchParams.get("mapped");
    const mapped =
      mappedRaw === null ? null : mappedRaw.toLowerCase() === "true";
    const q = boundedSearchQuery(searchParams.get("q"));

    const conditions = [sql`1=1`];
    if (mapped === true) {
      conditions.push(sql`link.awork_company_id IS NOT NULL`);
    } else if (mapped === false) {
      conditions.push(sql`link.awork_company_id IS NULL`);
    }
    if (q) {
      const like = `%${q}%`;
      conditions.push(sql`LOWER(aco.name) LIKE LOWER(${like})`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const r = await db.execute(sql`
      SELECT aco.awork_company_id, aco.name, aco.is_external,
             aco.projects_count, aco.projects_in_progress_count,
             link.customer_id, c.name AS our_customer_name
      FROM awork_company aco
      LEFT JOIN awork_company_link link
        ON link.awork_company_id = aco.awork_company_id
      LEFT JOIN customer c ON c.customer_id = link.customer_id
      WHERE ${whereClause}
      ORDER BY aco.projects_count DESC NULLS LAST, aco.name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      awork_company_id: row.awork_company_id,
      name: row.name,
      is_external: row.is_external,
      projects_count: row.projects_count,
      projects_in_progress_count: row.projects_in_progress_count,
      mapped_to_customer_id: row.customer_id ?? null,
      mapped_to_customer_name: row.our_customer_name ?? null,
    }));
  });
}
