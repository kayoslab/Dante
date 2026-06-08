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
    const r = await db.execute(sql`
      SELECT au.awork_user_id, au.first_name, au.last_name, au.email,
             COALESCE(t.n_entries, 0)::int AS n_entries
      FROM awork_user_link link
      JOIN awork_user au ON au.awork_user_id = link.awork_user_id
      LEFT JOIN (
        SELECT awork_user_id, COUNT(*) AS n_entries
        FROM awork_time_entry GROUP BY awork_user_id
      ) t ON t.awork_user_id = link.awork_user_id
      WHERE link.employee_id = ${employee_id}
      ORDER BY au.last_name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      awork_user_id: row.awork_user_id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      n_time_entries: Number(row.n_entries ?? 0),
      mapped_to_employee_id: employee_id,
      mapped_to_employee_name: null,
      position: null,
      title: null,
      is_archived: null,
      is_deactivated: null,
      is_external: null,
    }));
  });
}
