import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const mappedRaw = searchParams.get("mapped");
    const mapped =
      mappedRaw === null ? null : mappedRaw.toLowerCase() === "true";
    const q = searchParams.get("q");

    const conditions = [sql`1=1`];
    if (mapped === true) {
      conditions.push(sql`link.awork_project_id IS NOT NULL`);
    } else if (mapped === false) {
      conditions.push(sql`link.awork_project_id IS NULL`);
    }
    if (q) {
      const like = `%${q}%`;
      conditions.push(sql`LOWER(ap.name) LIKE LOWER(${like})`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const r = await db.execute(sql`
      SELECT ap.awork_project_id, ap.name, ap.project_key,
             ap.awork_company_id, co.name AS awork_company_name,
             ap.is_billable_by_default, ap.is_external,
             link.project_id, p.name AS our_project, c.name AS customer,
             COALESCE(t.n_entries, 0)::int AS n_entries
      FROM awork_project ap
      LEFT JOIN awork_company co ON co.awork_company_id = ap.awork_company_id
      LEFT JOIN awork_project_link link
        ON link.awork_project_id = ap.awork_project_id
      LEFT JOIN project p ON p.project_id = link.project_id
      LEFT JOIN customer c ON c.customer_id = p.customer_id
      LEFT JOIN (
        SELECT awork_project_id, COUNT(*) AS n_entries
        FROM awork_time_entry
        WHERE awork_project_id IS NOT NULL
        GROUP BY awork_project_id
      ) t ON t.awork_project_id = ap.awork_project_id
      WHERE ${whereClause}
      ORDER BY COALESCE(t.n_entries, 0) DESC, ap.name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      awork_project_id: row.awork_project_id,
      name: row.name,
      project_key: row.project_key,
      awork_company_id: row.awork_company_id,
      awork_company_name: row.awork_company_name ?? null,
      is_billable_by_default: row.is_billable_by_default,
      is_external: row.is_external,
      mapped_to_project_id: row.project_id ?? null,
      mapped_to_project_name: row.our_project ?? null,
      mapped_to_customer_name: row.customer ?? null,
      n_time_entries: Number(row.n_entries ?? 0),
    }));
  });
}
