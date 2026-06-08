import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const linkedRaw = searchParams.get("linked");
    const linked =
      linkedRaw === null ? null : linkedRaw.toLowerCase() === "true";
    const includeArchived =
      (searchParams.get("include_archived") ?? "false").toLowerCase() === "true";

    const conditions = [sql`1=1`];
    if (!includeArchived) {
      conditions.push(sql`COALESCE(au.is_archived, FALSE) = FALSE`);
    }
    if (linked === true) {
      conditions.push(sql`link.awork_user_id IS NOT NULL`);
    } else if (linked === false) {
      conditions.push(sql`link.awork_user_id IS NULL`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const r = await db.execute(sql`
      SELECT au.awork_user_id, au.first_name, au.last_name, au.email,
             au.position, au.title, au.is_archived, au.is_deactivated,
             au.is_external,
             link.employee_id,
             ec.first_name || ' ' || ec.last_name AS our_name,
             COALESCE(t.n_entries, 0)::int AS n_entries
      FROM awork_user au
      LEFT JOIN awork_user_link link ON link.awork_user_id = au.awork_user_id
      LEFT JOIN employee_current ec ON ec.employee_id = link.employee_id
      LEFT JOIN (
        SELECT awork_user_id, COUNT(*) AS n_entries
        FROM awork_time_entry GROUP BY awork_user_id
      ) t ON t.awork_user_id = au.awork_user_id
      WHERE ${whereClause}
      ORDER BY COALESCE(t.n_entries, 0) DESC, au.last_name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      awork_user_id: row.awork_user_id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      position: row.position,
      title: row.title,
      is_archived: row.is_archived,
      is_deactivated: row.is_deactivated,
      is_external: row.is_external,
      mapped_to_employee_id: row.employee_id ?? null,
      mapped_to_employee_name: row.our_name ?? null,
      n_time_entries: Number(row.n_entries ?? 0),
    }));
  });
}
