/** Per-project access control for Service Delivery Managers (SDMs).
 *
 * SDM is a capability layered on top of the `employee` role, NOT a new
 * tier in the role ladder. The ladder stays:
 *
 *     employee (0) < manager (1) < admin (2)
 *
 * An employee with rows in `project_sdm` is treated as a manager for
 * the linked project_ids. Admin/manager roles short-circuit the lookup
 * and never need a row in the table.
 *
 * Where to use which helper:
 *
 *   - Server Actions that operate on a known project_id:
 *       const auth = await requireProjectAccess(project_id);
 *       if (!auth.ok) return auth.result;
 *
 *   - Route handlers (/api/projects/[id]/*):
 *       const ctx = await requireApiProjectAccess(project_id);
 *
 *   - Read-side filters ("which projects can this user see?"):
 *       const ids = await getSdmProjectIds(ctx);
 *
 * Tight invariants:
 *   - canManageProject NEVER widens beyond manager-equivalent access.
 *     The mergeProjectsAction, deleteProjectAction, and createProjectAction
 *     deliberately stay on `requireActionRole("manager")` because they
 *     cross project boundaries or are unrecoverably destructive.
 *   - The lookup query is a single PK probe on (project_id, user_id).
 */
import {
  hasSdmGrant,
  listSdmProjectIdsForUser,
} from "@/lib/db/queries/project-sdm";

import {
  ForbiddenError,
  requireSession,
  type SessionContext,
} from "./session";
import {
  type ActionAuth,
} from "@/lib/actions/_action-helpers";
import {
  Forbidden,
  requireApiSession,
} from "@/lib/api/_route-helpers";

/** Does this user have manager-equivalent rights on this project? */
export async function canManageProject(
  ctx: SessionContext,
  project_id: number,
): Promise<boolean> {
  if (ctx.role === "admin" || ctx.role === "manager") return true;
  // Employee — check for an SDM grant on this specific project.
  return await hasSdmGrant(ctx.user_id, project_id);
}

/** Server-action gate. Mirrors `requireActionRole` — returns the same
 * discriminated `ActionAuth` so callers can early-return on failure. */
export async function requireProjectAccess(
  project_id: number,
): Promise<ActionAuth> {
  try {
    const ctx = await requireSession({ minRole: "employee" });
    if (!(await canManageProject(ctx, project_id))) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            code: "forbidden",
            detail: "You do not have access to this project.",
          },
        },
      };
    }
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return {
        ok: false,
        result: {
          ok: false,
          error: { code: "forbidden", detail: "Forbidden." },
        },
      };
    }
    throw e;
  }
}

/** Route-handler gate. Throws `HTTPError(403)` on rejection so the
 * surrounding `handle()` returns the standard JSON envelope. */
export async function requireApiProjectAccess(
  project_id: number,
): Promise<SessionContext> {
  const ctx = await requireApiSession({ minRole: "employee" });
  if (!(await canManageProject(ctx, project_id))) {
    throw Forbidden("You do not have access to this project.");
  }
  return ctx;
}

/** Project IDs this user has explicit SDM grants on. Empty array for
 * admin/manager — they have implicit access to everything and callers
 * should NOT filter by this list. Use `canManageProject` for them. */
export async function getSdmProjectIds(
  ctx: SessionContext,
): Promise<number[]> {
  if (ctx.role !== "employee") return [];
  return await listSdmProjectIdsForUser(ctx.user_id);
}
