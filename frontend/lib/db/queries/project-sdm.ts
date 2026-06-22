/** Per-project SDM grant queries.
 *
 * Read paths for the project-detail "Service Delivery Managers" sub-card
 * and the employee-picker that powers granting. The grant table itself
 * is tiny (we expect <100 rows ever), so these are simple joins. */
import { and, asc, eq, isNotNull, notInArray } from "drizzle-orm";

import { db } from "../client";
import { appUser, employeeCurrent, projectSdm } from "../schema";

/* ------------------------------------------------------------------ */
/* membership probes — backing the project-capability auth helpers      */
/* ------------------------------------------------------------------ */

/** True iff the user has an SDM grant on this exact project. PK probe
 * on (project_id, user_id). Used by `canManageProject` after the
 * admin/manager short-circuit. */
export async function hasSdmGrant(
  user_id: string,
  project_id: number,
): Promise<boolean> {
  const [row] = await db
    .select({ project_id: projectSdm.project_id })
    .from(projectSdm)
    .where(
      and(
        eq(projectSdm.project_id, project_id),
        eq(projectSdm.user_id, user_id),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Every project_id this user has an explicit SDM grant on. Caller
 * (project-capability.ts) handles the admin/manager short-circuit —
 * this is a pure DB read. */
export async function listSdmProjectIdsForUser(
  user_id: string,
): Promise<number[]> {
  const rows = await db
    .select({ project_id: projectSdm.project_id })
    .from(projectSdm)
    .where(eq(projectSdm.user_id, user_id));
  return rows.map((r) => r.project_id);
}

export type ProjectSdmRow = {
  user_id: string;
  email: string;
  employee_id: number | null;
  first_name: string | null;
  last_name: string | null;
  granted_at: string;
};

/** SDMs currently granted on a project. Joins to employee_current so the
 * UI can show real names; falls back to email for unlinked users. */
export async function listProjectSdms(
  project_id: number,
): Promise<ProjectSdmRow[]> {
  const rows = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      employee_id: appUser.employee_id,
      first_name: employeeCurrent.first_name,
      last_name: employeeCurrent.last_name,
      granted_at: projectSdm.granted_at,
    })
    .from(projectSdm)
    .innerJoin(appUser, eq(appUser.user_id, projectSdm.user_id))
    .leftJoin(
      employeeCurrent,
      eq(employeeCurrent.employee_id, appUser.employee_id),
    )
    .where(eq(projectSdm.project_id, project_id))
    .orderBy(asc(appUser.email));

  return rows.map((r) => ({
    user_id: r.user_id,
    email: r.email,
    employee_id: r.employee_id,
    first_name: r.first_name,
    last_name: r.last_name,
    granted_at: r.granted_at.toISOString(),
  }));
}

export type GrantableUser = {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

/** Employees (role='employee', not disabled, linked to a Personio record)
 * that don't already have a grant on this project. Used by the grant
 * picker. We deliberately exclude admin/manager — they have implicit
 * access and adding a row is a no-op. */
export async function listGrantableUsers(
  project_id: number,
): Promise<GrantableUser[]> {
  // Already-granted user_ids to exclude.
  const granted = await db
    .select({ user_id: projectSdm.user_id })
    .from(projectSdm)
    .where(eq(projectSdm.project_id, project_id));
  const grantedIds = granted.map((g) => g.user_id);

  const whereParts = [
    eq(appUser.role, "employee"),
    eq(appUser.is_disabled, false),
    isNotNull(appUser.employee_id),
  ];
  // notInArray with an empty array throws — only add the predicate when
  // there's at least one existing grant.
  const where =
    grantedIds.length > 0
      ? and(...whereParts, notInArray(appUser.user_id, grantedIds))
      : and(...whereParts);

  const rows = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      first_name: employeeCurrent.first_name,
      last_name: employeeCurrent.last_name,
    })
    .from(appUser)
    .innerJoin(
      employeeCurrent,
      eq(employeeCurrent.employee_id, appUser.employee_id),
    )
    .where(where)
    .orderBy(asc(employeeCurrent.first_name), asc(employeeCurrent.last_name));
  return rows;
}
