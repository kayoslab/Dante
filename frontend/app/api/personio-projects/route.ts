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
      conditions.push(sql`link.personio_project_id IS NOT NULL`);
    } else if (mapped === false) {
      conditions.push(sql`link.personio_project_id IS NULL`);
    }
    if (q) {
      const like = `%${q}%`;
      conditions.push(sql`LOWER(pp.name) LIKE LOWER(${like})`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const r = await db.execute(sql`
      SELECT pp.personio_project_id, pp.name, pp.active,
             link.project_id, p.name AS our_project, c.name AS customer,
             COALESCE(att.n_entries, 0)::int AS n_entries
      FROM personio_project pp
      LEFT JOIN personio_project_link link
        ON link.personio_project_id = pp.personio_project_id
      LEFT JOIN project p ON p.project_id = link.project_id
      LEFT JOIN customer c ON c.customer_id = p.customer_id
      LEFT JOIN (
        SELECT project_id AS personio_project_id, COUNT(*) AS n_entries
        FROM attendance WHERE project_id IS NOT NULL
        GROUP BY project_id
      ) att ON att.personio_project_id = pp.personio_project_id
      WHERE ${whereClause}
      ORDER BY COALESCE(att.n_entries, 0) DESC, pp.name
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      personio_project_id: row.personio_project_id,
      name: row.name,
      active: row.active,
      mapped_to_project_id: row.project_id ?? null,
      mapped_to_project_name: row.our_project ?? null,
      mapped_to_customer_name: row.customer ?? null,
      n_attendance_entries: Number(row.n_entries ?? 0),
    }));
  });
}
