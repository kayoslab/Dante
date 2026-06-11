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
      SELECT pp.personio_project_id, pp.name, pp.active,
             COALESCE(att.n_entries, 0)::int AS n_entries, link.mapped_at
      FROM personio_project_link link
      JOIN personio_project pp
        ON pp.personio_project_id = link.personio_project_id
      LEFT JOIN (
        SELECT project_id AS personio_project_id, COUNT(*) AS n_entries
        FROM attendance WHERE project_id IS NOT NULL
        GROUP BY project_id
      ) att ON att.personio_project_id = link.personio_project_id
      WHERE link.project_id = ${project_id}
      ORDER BY pp.name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      personio_project_id: row.personio_project_id,
      name: row.name,
      active: row.active,
      n_attendance_entries: Number(row.n_entries ?? 0),
      mapped_to_project_id: project_id,
      mapped_to_project_name: null,
      mapped_to_customer_name: null,
    }));
  });
}
