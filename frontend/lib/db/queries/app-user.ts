import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import { appUser, employeeCurrent } from "../schema";

/* ------------------------------------------------------------------ */
/* invite                                                              */
/* ------------------------------------------------------------------ */

/** Lookup an existing app_user by case-insensitive email. Used by
 * `inviteUserAction` for the friendly duplicate guard (the unique
 * index would also catch it, but this surfaces a nicer message). */
export async function findAppUserByEmail(
  email: string,
): Promise<{ user_id: string } | null> {
  const rows = await db
    .select({ user_id: appUser.user_id })
    .from(appUser)
    .where(sql`LOWER(${appUser.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows[0] ?? null;
}

/** Try to auto-link an invite to an `employee_current` row by exact
 * email match (case-insensitive). NULL when no employee exists yet. */
export async function findEmployeeIdByEmail(
  email: string,
): Promise<number | null> {
  const rows = await db
    .select({ employee_id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(sql`LOWER(${employeeCurrent.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows[0]?.employee_id ?? null;
}

export type InsertedAppUser = {
  user_id: string;
  email: string;
  role: "admin" | "manager" | "employee";
};

/** Insert a fresh app_user row. The caller resolves `cognito_sub`
 * (real Cognito `sub` in prod; `dev:<email>` stub in dev mode). */
export async function insertAppUser(input: {
  cognito_sub: string;
  email: string;
  role: "admin" | "manager" | "employee";
  employee_id: number | null;
}): Promise<InsertedAppUser> {
  const [row] = await db
    .insert(appUser)
    .values({
      cognito_sub: input.cognito_sub,
      email: input.email,
      role: input.role,
      employee_id: input.employee_id,
    })
    .returning({
      user_id: appUser.user_id,
      email: appUser.email,
      role: appUser.role,
    });
  return row;
}

/* ------------------------------------------------------------------ */
/* role change (with last-admin guard inside a single transaction)     */
/* ------------------------------------------------------------------ */

export type RoleChange = {
  user_id: string;
  role: "admin" | "manager" | "employee";
  email: string;
  cognito_sub: string;
  previous_role: "admin" | "manager" | "employee";
};

export type UpdateUserRoleOutcome =
  | { kind: "ok"; data: RoleChange }
  | { kind: "last_admin_guard" }
  | { kind: "not_found" };

/** Atomic role change with the last-admin guard. Wraps the admin-count
 * check (with `SELECT ... FOR UPDATE`) and the role write in one
 * transaction so two concurrent demotions can't both pass the count
 * check and leave zero admins (was H-002 in the pre-launch pen test).
 *
 * Returns a discriminated union the action interprets:
 *   - `ok`              — DB write succeeded; caller syncs Cognito groups
 *   - `last_admin_guard` — refused because demoting the last admin
 *   - `not_found`        — user_id doesn't exist
 */
export async function updateUserRoleWithLastAdminGuard(input: {
  user_id: string;
  role: "admin" | "manager" | "employee";
  demotingSelf: boolean;
}): Promise<UpdateUserRoleOutcome> {
  return db.transaction(async (tx): Promise<UpdateUserRoleOutcome> => {
    if (input.demotingSelf) {
      const admins = await tx
        .select({ user_id: appUser.user_id })
        .from(appUser)
        .where(eq(appUser.role, "admin"))
        .for("update");
      if (admins.length <= 1) return { kind: "last_admin_guard" };
    }
    // Capture current state before the update so the action can sync
    // Cognito groups afterwards (needs the OLD role for
    // AdminRemoveUserFromGroup + the email for both group calls + the
    // cognito_sub to know whether to skip the Cognito hop in dev mode).
    const before = await tx
      .select({
        email: appUser.email,
        role: appUser.role,
        cognito_sub: appUser.cognito_sub,
      })
      .from(appUser)
      .where(eq(appUser.user_id, input.user_id))
      .limit(1);
    if (!before[0]) return { kind: "not_found" };
    const updated = await tx
      .update(appUser)
      .set({ role: input.role })
      .where(eq(appUser.user_id, input.user_id))
      .returning({ user_id: appUser.user_id, role: appUser.role });
    if (!updated[0]) return { kind: "not_found" };
    return {
      kind: "ok",
      data: {
        ...updated[0],
        email: before[0].email,
        cognito_sub: before[0].cognito_sub,
        previous_role: before[0].role,
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* disable / enable                                                    */
/* ------------------------------------------------------------------ */

/** Read the email + cognito_sub for the target user before flipping the
 * disabled flag — the action needs both to mirror the change in Cognito
 * (AdminDisableUser / AdminEnableUser + AdminUserGlobalSignOut). */
export async function getAppUserEmailAndSub(
  user_id: string,
): Promise<{ email: string; cognito_sub: string } | null> {
  const rows = await db
    .select({
      email: appUser.email,
      cognito_sub: appUser.cognito_sub,
    })
    .from(appUser)
    .where(eq(appUser.user_id, user_id))
    .limit(1);
  return rows[0] ?? null;
}

/** Toggle the `is_disabled` flag. Returns the updated row or NULL when
 * the user doesn't exist. */
export async function setAppUserDisabled(
  user_id: string,
  disabled: boolean,
): Promise<{ user_id: string; is_disabled: boolean } | null> {
  const rows = await db
    .update(appUser)
    .set({ is_disabled: disabled })
    .where(eq(appUser.user_id, user_id))
    .returning({
      user_id: appUser.user_id,
      is_disabled: appUser.is_disabled,
    });
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* delete                                                              */
/* ------------------------------------------------------------------ */

export type AppUserDeleteTarget = {
  user_id: string;
  email: string;
  is_disabled: boolean;
  cognito_sub: string;
};

/** Look up the email + disabled-flag + sub before deleting; we need
 * the email for AdminDeleteUser, the disabled flag to enforce the
 * "must be disabled first" gate, and the sub to know whether to skip
 * Cognito (dev stub). */
export async function getAppUserForDelete(
  user_id: string,
): Promise<AppUserDeleteTarget | null> {
  const rows = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      is_disabled: appUser.is_disabled,
      cognito_sub: appUser.cognito_sub,
    })
    .from(appUser)
    .where(eq(appUser.user_id, user_id))
    .limit(1);
  return rows[0] ?? null;
}

/** Hard-delete an app_user row. The `app_audit_log.user_id` FK is
 * `ON DELETE SET NULL`, so historical audit rows survive. */
export async function deleteAppUser(user_id: string): Promise<void> {
  await db.delete(appUser).where(eq(appUser.user_id, user_id));
}

/* ------------------------------------------------------------------ */
/* resend invitation / reset password                                  */
/* ------------------------------------------------------------------ */

/** Read just enough to drive the resend / reset gates: email (for the
 * Cognito call) + last_login_at (to pick the right Cognito API). */
export async function getAppUserEmailAndLastLogin(
  user_id: string,
): Promise<{ email: string; last_login_at: Date | null } | null> {
  const rows = await db
    .select({ email: appUser.email, last_login_at: appUser.last_login_at })
    .from(appUser)
    .where(eq(appUser.user_id, user_id))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* link to employee                                                    */
/* ------------------------------------------------------------------ */

/** Re-point an app_user at a different employee_current row (or NULL
 * to unlink). Returns the updated row or NULL when the user doesn't
 * exist. */
export async function setAppUserEmployee(
  user_id: string,
  employee_id: number | null,
): Promise<{ user_id: string; employee_id: number | null } | null> {
  const rows = await db
    .update(appUser)
    .set({ employee_id })
    .where(eq(appUser.user_id, user_id))
    .returning({
      user_id: appUser.user_id,
      employee_id: appUser.employee_id,
    });
  return rows[0] ?? null;
}
