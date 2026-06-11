import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { Validation, handle } from "@/lib/api/_route-helpers";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id: rawId } = await params;
    const project_id = Number(rawId);
    if (!Number.isInteger(project_id)) {
      throw Validation(`invalid project id: ${rawId}`);
    }
    await requireApiProjectAccess(project_id);
    const r = await db.execute(sql`
      SELECT ap.awork_project_id, ap.name, ap.project_key,
             ap.awork_company_id, co.name AS awork_company_name,
             COALESCE(t.n_entries, 0)::int AS n_entries
      FROM awork_project_link link
      JOIN awork_project ap ON ap.awork_project_id = link.awork_project_id
      LEFT JOIN awork_company co ON co.awork_company_id = ap.awork_company_id
      LEFT JOIN (
        SELECT awork_project_id, COUNT(*) AS n_entries
        FROM awork_time_entry
        WHERE awork_project_id IS NOT NULL
        GROUP BY awork_project_id
      ) t ON t.awork_project_id = link.awork_project_id
      WHERE link.project_id = ${project_id}
      ORDER BY ap.name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      awork_project_id: row.awork_project_id,
      name: row.name,
      project_key: row.project_key,
      awork_company_id: row.awork_company_id,
      awork_company_name: row.awork_company_name ?? null,
      mapped_to_project_id: project_id,
      mapped_to_project_name: null,
      mapped_to_customer_name: null,
      is_billable_by_default: null,
      is_external: null,
      n_time_entries: Number(row.n_entries ?? 0),
    }));
  });
}
