/** Queries backing the `/api/personio-projects` route — the surface the
 * "map Personio time-tracking project → Dante project" admin UI uses.
 *
 * The route filters by mapped/unmapped state and by free-text name; the
 * filter logic stays SQL-side (LIKE on the name column, IS NULL / NOT NULL
 * on the link). Wire shape matches the existing route exactly. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export type PersonioProjectListItem = {
  personio_project_id: string;
  name: string;
  active: boolean;
  mapped_to_project_id: number | null;
  mapped_to_project_name: string | null;
  mapped_to_customer_name: string | null;
  n_attendance_entries: number;
};

/** List Personio projects (the time-tracking ones), optionally filtered
 * by mapping state and free-text name. `q` must be pre-bounded by
 * `boundedSearchQuery` at the route layer. */
export async function listPersonioProjects(opts: {
  mapped: boolean | null;
  q: string | null;
}): Promise<PersonioProjectListItem[]> {
  // "mapped" means "currently linked to an existing Dante project", not
  // "a link row exists". The schema-level ON DELETE CASCADE (migration
  // 0017) makes the two equivalent under normal operation, but treating
  // the join through `project` defensively means a deploy-window race
  // (old container hits the DB before the migration lands) or an
  // operator who manually deletes a project row without cascade still
  // self-heals on the picker side.
  const conditions = [sql`1=1`];
  if (opts.mapped === true) {
    conditions.push(sql`link.personio_project_id IS NOT NULL AND p.project_id IS NOT NULL`);
  } else if (opts.mapped === false) {
    conditions.push(sql`link.personio_project_id IS NULL OR p.project_id IS NULL`);
  }
  if (opts.q) {
    const like = `%${opts.q}%`;
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
    ORDER BY LOWER(pp.name)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    personio_project_id: row.personio_project_id as string,
    name: row.name as string,
    active: row.active as boolean,
    mapped_to_project_id: (row.project_id as number | null) ?? null,
    mapped_to_project_name: (row.our_project as string | null) ?? null,
    mapped_to_customer_name: (row.customer as string | null) ?? null,
    n_attendance_entries: Number(row.n_entries ?? 0),
  }));
}
