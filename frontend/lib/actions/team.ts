"use server";

/** Phase C.6 — Team mutations as Server Actions.
 *
 * Ports `src/dante/api/service/team.py` to TypeScript. Three
 * actions: create / rename / delete. Rename cascades the new name into
 * every assigned employee's `employee_annotation.team_user` in the same
 * transaction (denormalized column kept consistent with `team.team_name`).
 * Delete with `force=true` clears `team_user` on members before removing.
 */
import { z } from "zod";

import {
  clearTeamMembers,
  countTeamMembers,
  deleteTeamRow,
  getTeamItem,
  insertTeam,
  renameTeamWithCascade,
  teamExists,
  type TeamItem,
} from "@/lib/db/queries/team";
import { audit } from "@/lib/auth/audit";

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

export type { TeamItem } from "@/lib/db/queries/team";
export type TeamDeleteResult = { team_name: string; members_cleared: number };

// ----------------------------------------------------------------------------
// createTeamAction
// ----------------------------------------------------------------------------

export async function createTeamAction(
  input: unknown,
): Promise<ActionResult<TeamItem>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const parsed = CreateTeamSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const name = parsed.data.name.trim();
  if (!name) return err("validation_error", "team name required");

  if (await teamExists(name)) {
    await audit(ctx, {
      action: "team_created_denied",
      target_type: "team",
      target_id: name,
    });
    return err("conflict", `team '${name}' already exists`);
  }

  await insertTeam(name);
  await audit(ctx, {
    action: "team_created",
    target_type: "team",
    target_id: name,
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
  const ctx = auth.ctx;

  const parsed = RenameTeamSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const new_name = parsed.data.new_name.trim();
  if (!new_name) return err("validation_error", "new name required");

  if (!(await teamExists(old_name))) {
    await audit(ctx, {
      action: "team_renamed_denied",
      target_type: "team",
      target_id: old_name,
    });
    return err("not_found", `team '${old_name}' not found`);
  }
  if (old_name === new_name) {
    const t = await getTeamItem(old_name);
    if (!t) {
      await audit(ctx, {
        action: "team_renamed_denied",
        target_type: "team",
        target_id: old_name,
      });
      return err("not_found", `team '${old_name}' not found`);
    }
    return ok(t);
  }
  if (await teamExists(new_name)) {
    await audit(ctx, {
      action: "team_renamed_denied",
      target_type: "team",
      target_id: old_name,
    });
    return err("conflict", `team '${new_name}' already exists`);
  }

  await renameTeamWithCascade(old_name, new_name);

  const t = await getTeamItem(new_name);
  if (!t) return err("internal_error", "renamed team not found");
  await audit(ctx, {
    action: "team_renamed",
    target_type: "team",
    target_id: new_name,
  });
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
  const ctx = auth.ctx;

  if (!(await teamExists(team_name))) {
    await audit(ctx, {
      action: "team_deleted_denied",
      target_type: "team",
      target_id: team_name,
    });
    return err("not_found", `team '${team_name}' not found`);
  }
  const n_members = await countTeamMembers(team_name);
  if (n_members > 0 && !force) {
    await audit(ctx, {
      action: "team_deleted_denied",
      target_type: "team",
      target_id: team_name,
    });
    return err(
      "conflict",
      `team '${team_name}' has ${n_members} member(s); pass force=true to clear the team from their profiles and delete anyway`,
    );
  }
  if (n_members > 0) {
    await clearTeamMembers(team_name);
  }
  await deleteTeamRow(team_name);
  await audit(ctx, {
    action: "team_deleted",
    target_type: "team",
    target_id: team_name,
  });
  return ok({ team_name, members_cleared: n_members });
}
