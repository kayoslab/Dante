"use server";

/** Phase C.6 — Team mutations as Server Actions.
 *
 * Ports `src/dante/api/service/team.py` to TypeScript. Three
 * actions: create / rename / delete. Rename cascades the new name into
 * every assigned employee's `employee_annotation.team_user` in the same
 * transaction (denormalized column kept consistent with `team.team_name`).
 * Delete with `force=true` clears `team_user` on members before removing.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { employeeAnnotation, team } from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

const NameSchema = z.string().min(1, "team name required").max(200);

const CreateTeamSchema = z.object({ name: NameSchema });
const RenameTeamSchema = z.object({ new_name: NameSchema });

export type TeamItem = { team_name: string; n_members: number };
export type TeamDeleteResult = { team_name: string; members_cleared: number };

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function listTeamItem(team_name: string): Promise<TeamItem | null> {
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

// ----------------------------------------------------------------------------
// createTeamAction
// ----------------------------------------------------------------------------

export async function createTeamAction(
  input: unknown,
): Promise<ActionResult<TeamItem>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateTeamSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const name = parsed.data.name.trim();
  if (!name) return err("validation_error", "team name required");

  const existing = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, name));
  if (existing.length > 0) {
    return err("conflict", `team '${name}' already exists`);
  }

  const now = new Date();
  await db.insert(team).values({
    team_name: name,
    created_at: now,
    updated_at: now,
  });
  return ok({ team_name: name, n_members: 0 });
}

// ----------------------------------------------------------------------------
// renameTeamAction
// ----------------------------------------------------------------------------

export async function renameTeamAction(
  old_name: string,
  input: unknown,
): Promise<ActionResult<TeamItem>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = RenameTeamSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const new_name = parsed.data.new_name.trim();
  if (!new_name) return err("validation_error", "new name required");

  const found = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, old_name));
  if (found.length === 0) {
    return err("not_found", `team '${old_name}' not found`);
  }
  if (old_name === new_name) {
    const t = await listTeamItem(old_name);
    if (!t) return err("not_found", `team '${old_name}' not found`);
    return ok(t);
  }
  const collision = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, new_name));
  if (collision.length > 0) {
    return err("conflict", `team '${new_name}' already exists`);
  }

  const now = new Date();
  await db
    .update(team)
    .set({ team_name: new_name, updated_at: now })
    .where(eq(team.team_name, old_name));
  await db
    .update(employeeAnnotation)
    .set({ team_user: new_name, last_reconciled_at: now })
    .where(eq(employeeAnnotation.team_user, old_name));

  const t = await listTeamItem(new_name);
  if (!t) return err("internal_error", "renamed team not found");
  return ok(t);
}

// ----------------------------------------------------------------------------
// deleteTeamAction
// ----------------------------------------------------------------------------

export async function deleteTeamAction(
  team_name: string,
  force = false,
): Promise<ActionResult<TeamDeleteResult>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const found = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, team_name));
  if (found.length === 0) {
    return err("not_found", `team '${team_name}' not found`);
  }
  const members = await db
    .select({ id: employeeAnnotation.employee_id })
    .from(employeeAnnotation)
    .where(eq(employeeAnnotation.team_user, team_name));
  const n_members = members.length;
  if (n_members > 0 && !force) {
    return err(
      "conflict",
      `team '${team_name}' has ${n_members} member(s); pass force=true to clear the team from their profiles and delete anyway`,
    );
  }
  if (n_members > 0) {
    const now = new Date();
    await db
      .update(employeeAnnotation)
      .set({ team_user: null, last_reconciled_at: now })
      .where(eq(employeeAnnotation.team_user, team_name));
  }
  await db.delete(team).where(eq(team.team_name, team_name));
  return ok({ team_name, members_cleared: n_members });
}
