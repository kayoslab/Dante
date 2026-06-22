import { asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { employeeAnnotation, team } from "../schema";

/** Compact row returned by `getTeamItem` and friends. The action layer
 * uses this verbatim — keep the field shape stable. */
export type TeamItem = { team_name: string; n_members: number };

/** Full team listing with member counts. Used by `/api/teams` for
 * the manager-facing team picker. Ordered by name for stable UI. */
export async function listTeams(): Promise<TeamItem[]> {
  const rows = await db
    .select({
      team_name: team.team_name,
      n_members: sql<number>`COUNT(${employeeAnnotation.employee_id})::int`.as(
        "n_members",
      ),
    })
    .from(team)
    .leftJoin(
      employeeAnnotation,
      eq(employeeAnnotation.team_user, team.team_name),
    )
    .groupBy(team.team_name)
    .orderBy(asc(team.team_name));
  return rows.map((r) => ({
    team_name: r.team_name,
    n_members: Number(r.n_members),
  }));
}

/** Existence probe: does a team with this exact name exist? */
export async function teamExists(team_name: string): Promise<boolean> {
  const rows = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, team_name));
  return rows.length > 0;
}

/** Fetch a single team's list row (name + member count from the
 * `employee_annotation.team_user` denormalised column). Returns null
 * when the team isn't on file. */
export async function getTeamItem(
  team_name: string,
): Promise<TeamItem | null> {
  const r = await db.execute(sql`
    SELECT t.team_name, COUNT(a.employee_id)::int AS n_members
    FROM team t
    LEFT JOIN employee_annotation a ON a.team_user = t.team_name
    WHERE t.team_name = ${team_name}
    GROUP BY t.team_name
  `);
  const row = (r.rows as Array<{ team_name: string; n_members: number }>)[0];
  if (!row) return null;
  return { team_name: row.team_name, n_members: Number(row.n_members) };
}

/** Insert a brand-new team row. Caller is responsible for the duplicate
 * pre-check; this throws on PK violation. */
export async function insertTeam(team_name: string): Promise<void> {
  const now = new Date();
  await db.insert(team).values({
    team_name,
    created_at: now,
    updated_at: now,
  });
}

/** Rename a team and cascade the new label into every assigned
 * employee's denormalised `employee_annotation.team_user` so the two
 * columns stay consistent. Both writes share a single timestamp so the
 * rename's `last_reconciled_at` lines up across rows. */
export async function renameTeamWithCascade(
  old_name: string,
  new_name: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(team)
    .set({ team_name: new_name, updated_at: now })
    .where(eq(team.team_name, old_name));
  await db
    .update(employeeAnnotation)
    .set({ team_user: new_name, last_reconciled_at: now })
    .where(eq(employeeAnnotation.team_user, old_name));
}

/** Count of employees currently assigned to a team via
 * `employee_annotation.team_user`. */
export async function countTeamMembers(team_name: string): Promise<number> {
  const rows = await db
    .select({ id: employeeAnnotation.employee_id })
    .from(employeeAnnotation)
    .where(eq(employeeAnnotation.team_user, team_name));
  return rows.length;
}

/** Clear every employee's `team_user` for a soon-to-be-deleted team.
 * Used by `deleteTeamAction` when `force=true`. Stamps
 * `last_reconciled_at` on the touched rows. */
export async function clearTeamMembers(team_name: string): Promise<void> {
  const now = new Date();
  await db
    .update(employeeAnnotation)
    .set({ team_user: null, last_reconciled_at: now })
    .where(eq(employeeAnnotation.team_user, team_name));
}

/** Delete the team row itself. Caller has already cleared members (or
 * confirmed there are none) before invoking. */
export async function deleteTeamRow(team_name: string): Promise<void> {
  await db.delete(team).where(eq(team.team_name, team_name));
}
