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
};

const USER_SELECT = {
  user_id: appUser.user_id,
  email: appUser.email,
  employee_id: appUser.employee_id,
  role: appUser.role,
  is_disabled: appUser.is_disabled,
};

/** Find by cognito_sub OR by lowercased email; create if missing.
 * Optionally synchronize role to a caller-supplied value (Cognito groups). */
/** Look up the `employee_current.employee_id` whose email matches.
 * Case-insensitive. Returns null if no match (typical for service
 * accounts or pre-Personio-sync sign-ins). */
async function lookupEmployeeIdByEmail(
  lowerEmail: string,
): Promise<number | null> {
  const m = await db
    .select({ employee_id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(sql`LOWER(${employeeCurrent.email}) = ${lowerEmail}`)
    .limit(1);
  return m[0]?.employee_id ?? null;
}

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
    // Self-heal the employee_id link on each login: the original
    // email-match runs once on insert. If the Personio sync had not
    // yet imported this person at that moment (or their email was
    // added/corrected later), the link is permanently NULL otherwise.
    // Retry per-login while it's still null so the SDM grant picker,
    // /profile and every employee-scoped view start working on the
    // next sign-in instead of needing an admin DB poke.
    let employee_id = bySub[0].employee_id;
    if (employee_id === null) {
      employee_id = await lookupEmployeeIdByEmail(lowerEmail);
      if (employee_id !== null) update.employee_id = employee_id;
    }
    await db
      .update(appUser)
      .set(update)
      .where(eq(appUser.user_id, bySub[0].user_id));
    return {
      ...bySub[0],
      employee_id,
      role: (update.role as Role | undefined) ?? bySub[0].role,
    };
  }

  // Email match — typical "row was created with a stub cognito_sub in
  // dev mode, real Cognito sub is arriving now" case. Upgrade the row.
  //
  // Guard against the identity-merge attack (M-001 in the pre-launch
  // pen test): if the existing row has a real Cognito sub already, an
  // upgrade would silently transfer one user's identity to another.
  // Only allow the upgrade when the existing sub is a dev-mode stub
  // (`dev:...`). Anything else is either a case-collision attack or a
  // genuine duplicate that needs admin attention.
  const byEmail = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      employee_id: appUser.employee_id,
      role: appUser.role,
      is_disabled: appUser.is_disabled,
      cognito_sub: appUser.cognito_sub,
    })
    .from(appUser)
    .where(sql`LOWER(${appUser.email}) = ${lowerEmail}`)
    .limit(1);
  if (byEmail[0]) {
    const existingSub = byEmail[0].cognito_sub;
    if (!existingSub.startsWith("dev:")) {
      throw new Error(
        `Refusing to upgrade app_user ${byEmail[0].user_id}: existing ` +
          `cognito_sub is not a dev stub. This typically means two ` +
          `accounts collided on the same email — investigate via psql ` +
          `before allowing sign-in.`,
      );
    }
    const update: Record<string, unknown> = {
      cognito_sub: input.cognito_sub,
      last_login_at: new Date(),
    };
    if (input.expected_role && byEmail[0].role !== input.expected_role) {
      update.role = input.expected_role;
    }
    // Same self-heal as the bySub branch above — if the original
    // first-signin email match missed (Personio sync hadn't run yet),
    // retry now.
    let employee_id = byEmail[0].employee_id;
    if (employee_id === null) {
      employee_id = await lookupEmployeeIdByEmail(lowerEmail);
      if (employee_id !== null) update.employee_id = employee_id;
    }
    await db
      .update(appUser)
      .set(update)
      .where(eq(appUser.user_id, byEmail[0].user_id));
    return {
      user_id: byEmail[0].user_id,
      email: byEmail[0].email,
      employee_id,
      role: (update.role as Role | undefined) ?? byEmail[0].role,
      is_disabled: byEmail[0].is_disabled,
    };
  }

  // First sign-in. Auto-link to employee_current by email if possible.
  // (Subsequent sign-ins retry the same lookup in the bySub/byEmail
  // branches above if employee_id is still null.)
  const employee_id = await lookupEmployeeIdByEmail(lowerEmail);
  const role = input.expected_role ?? "employee";
  const inserted = await db
    .insert(appUser)
    .values({
      cognito_sub: input.cognito_sub,
      email,
      employee_id,
      role,
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
