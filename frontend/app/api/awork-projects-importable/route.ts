import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const customerIdRaw = searchParams.get("customer_id");
    const customer_id =
      customerIdRaw === null ? null : Number(customerIdRaw);

    // company linked + not yet mapped to one of our projects
    const conditions = [
      sql`link.customer_id IS NOT NULL`,
      sql`proj_link.project_id IS NULL`,
    ];
    if (customer_id !== null && Number.isInteger(customer_id)) {
      conditions.push(sql`link.customer_id = ${customer_id}`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const r = await db.execute(sql`
      SELECT ap.awork_project_id, ap.name, ap.project_key, ap.awork_company_id,
             aco.name AS awork_company_name,
             ap.start_date, ap.due_date, ap.closed_on,
             ap.time_budget_seconds, ap.project_status_type,
             ap.project_status_name, ap.description,
             COALESCE(t.n_entries, 0)::int AS n_entries,
             link.customer_id, c.name AS customer_name
      FROM awork_project ap
      LEFT JOIN awork_company aco ON aco.awork_company_id = ap.awork_company_id
      LEFT JOIN awork_company_link link
        ON link.awork_company_id = ap.awork_company_id
      LEFT JOIN customer c ON c.customer_id = link.customer_id
      LEFT JOIN awork_project_link proj_link
        ON proj_link.awork_project_id = ap.awork_project_id
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
      start_date: row.start_date,
      due_date: row.due_date,
      closed_on: row.closed_on,
      // Same int-division as the Python: `seconds // 3600`.
      time_budget_hours:
        row.time_budget_seconds === null || row.time_budget_seconds === undefined
          ? null
          : Math.floor(Number(row.time_budget_seconds) / 3600),
      project_status_type: row.project_status_type,
      project_status_name: row.project_status_name,
      description: row.description,
      n_time_entries: Number(row.n_entries ?? 0),
      mapped_to_customer_id: row.customer_id,
      mapped_to_customer_name: row.customer_name,
    }));
  });
}
