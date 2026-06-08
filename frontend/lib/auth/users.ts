/** First-sign-in user provisioning + role lookup helpers.
 *
 * Both dev mode and the real Cognito flow funnel through `findOrCreateAppUser`
 * so the `app_user` row is materialized exactly once per identity and the
 * link to `employee_current` is attempted by exact email match.
 *
 * Role lives on `app_user.role`. In dev mode it's the source of truth; in
 * prod the JWT's `cognito:groups` claim is authoritative and we sync the
 * column to match on each sign-in (callers pass the desired role through
 * the optional `expected_role` arg).
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { appUser, employeeCurrent } from "@/lib/db/schema";

import type { Role } from "./config";

export type AppUserRow = {
  user_id: string;
  email: string;
  employee_id: number | null;
  role: Role;
  is_disabled: boolean;
  mfa_required: boolean;
  mfa_enrolled: boolean;
};

const USER_SELECT = {
  user_id: appUser.user_id,
  email: appUser.email,
  employee_id: appUser.employee_id,
  role: appUser.role,
  is_disabled: appUser.is_disabled,
  mfa_required: appUser.mfa_required,
  // mfa_enrolled is derived — we never need the secret here, just the
  // boolean state. NOT NULL check via SQL expression.
  mfa_enrolled: sql<boolean>`${appUser.mfa_enrolled_at} IS NOT NULL`,
};

/** Find by cognito_sub OR by lowercased email; create if missing.
 * Optionally synchronize role to a caller-supplied value (Cognito groups). */
export async function findOrCreateAppUser(input: {
  email: string;
  cognito_sub: string;
  /** When set, persist this as the user's role. Used by the Cognito flow
   * to propagate `cognito:groups` claim → DB. Dev mode sets it from the
   * email-based override env vars. */
  expected_role?: Role;
}): Promise<AppUserRow> {
  const email = input.email.trim();
  const lowerEmail = email.toLowerCase();

  // Fast path — already provisioned.
  const bySub = await db
    .select(USER_SELECT)
    .from(appUser)
    .where(eq(appUser.cognito_sub, input.cognito_sub))
    .limit(1);
  if (bySub[0]) {
    const update: Record<string, unknown> = { last_login_at: new Date() };
    if (input.expected_role && bySub[0].role !== input.expected_role) {
      update.role = input.expected_role;
    }
    await db
      .update(appUser)
      .set(update)
      .where(eq(appUser.user_id, bySub[0].user_id));
    return {
      ...bySub[0],
      role: (update.role as Role | undefined) ?? bySub[0].role,
    };
  }

  // Email match — typical "row was created with a stub cognito_sub in dev
  // mode, real Cognito sub is arriving now" case. Upgrade the row.
  const byEmail = await db
    .select(USER_SELECT)
    .from(appUser)
    .where(sql`LOWER(${appUser.email}) = ${lowerEmail}`)
    .limit(1);
  if (byEmail[0]) {
    const update: Record<string, unknown> = {
      cognito_sub: input.cognito_sub,
      last_login_at: new Date(),
    };
    if (input.expected_role && byEmail[0].role !== input.expected_role) {
      update.role = input.expected_role;
    }
    await db
      .update(appUser)
      .set(update)
      .where(eq(appUser.user_id, byEmail[0].user_id));
    return {
      ...byEmail[0],
      role: (update.role as Role | undefined) ?? byEmail[0].role,
    };
  }

  // First sign-in. Auto-link to employee_current by email if possible.
  const empMatch = await db
    .select({ employee_id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(sql`LOWER(${employeeCurrent.email}) = ${lowerEmail}`)
    .limit(1);

  const role = input.expected_role ?? "employee";
  const inserted = await db
    .insert(appUser)
    .values({
      cognito_sub: input.cognito_sub,
      email,
      employee_id: empMatch[0]?.employee_id ?? null,
      role,
      // admin + manager are MFA-required by default; employees can opt in.
      mfa_required: role !== "employee",
      last_login_at: new Date(),
    })
    .returning(USER_SELECT);

  return inserted[0];
}

/** Backfill helper: ensure every employee_current row with an email has at
 * most one app_user row linking to it. */
export async function findUnlinkedEmployeesWithEmail(): Promise<
  Array<{ employee_id: number; email: string }>
> {
  return db
    .select({
      employee_id: employeeCurrent.employee_id,
      email: employeeCurrent.email,
    })
    .from(employeeCurrent)
    .leftJoin(
      appUser,
      sql`LOWER(${appUser.email}) = LOWER(${employeeCurrent.email})`,
    )
    .where(
      and(
        sql`${employeeCurrent.email} IS NOT NULL`,
        isNull(appUser.user_id),
      ),
    ) as unknown as Array<{ employee_id: number; email: string }>;
}
