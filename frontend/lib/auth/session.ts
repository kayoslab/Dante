/** Server-side session enforcement.
 *
 * `requireSession({ minRole })` is the single helper every Server
 * Component page, route handler, and Server Action calls at the top. It:
 *   - redirects to /login if there's no session
 *   - throws a 403 Forbidden if the user lacks the minimum role
 *   - returns a typed `SessionContext` for the page/action body
 *
 * The role hierarchy (admin > manager > employee) is checked numerically.
 * Pages that should be reachable by any signed-in user (employees
 * included) call `requireSession()` with no arg.
 */
import { redirect } from "next/navigation";

import { auth, type Role } from ".";

export type SessionContext = {
  user_id: string;
  email: string;
  role: Role;
  employee_id: number | null;
  mfa_required: boolean;
  mfa_enrolled: boolean;
  mfa_verified: boolean;
};

export const ROLE_RANK: Record<Role, number> = {
  employee: 0,
  manager: 1,
  admin: 2,
};

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Use from a Server Component or Server Action. Redirects:
 *  - unauthenticated → /login
 *  - signed in but MFA required + not enrolled → /auth/mfa/setup
 *  - signed in + MFA required + enrolled + not verified → /auth/mfa/verify
 *
 * Throws `ForbiddenError` if the role is below `minRole`.
 *
 * Pages that ARE the MFA setup/verify pages must pass
 * `{ allowMfaPending: true }` so this helper doesn't redirect them in a loop. */
export async function requireSession(opts: {
  minRole?: Role;
  /** Bypass the MFA-gate redirect. Used by the `/auth/mfa/*` pages
   * themselves and by `/api/auth/*`. */
  allowMfaPending?: boolean;
} = {}): Promise<SessionContext> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  const ctx: SessionContext = {
    user_id: session.user.user_id,
    email: session.user.email,
    role: session.user.role,
    employee_id: session.user.employee_id,
    mfa_required: session.user.mfa_required,
    mfa_enrolled: session.user.mfa_enrolled,
    mfa_verified: session.user.mfa_verified,
  };
  if (!opts.allowMfaPending && ctx.mfa_required && !ctx.mfa_verified) {
    redirect(ctx.mfa_enrolled ? "/auth/mfa/verify" : "/auth/mfa/setup");
  }
  if (opts.minRole && ROLE_RANK[ctx.role] < ROLE_RANK[opts.minRole]) {
    throw new ForbiddenError(
      `requires role ${opts.minRole} or above (you are ${ctx.role})`,
    );
  }
  return ctx;
}

/** Non-throwing variant — returns null if not signed in. Used by middleware
 * and by pages that need to render different content per role without
 * forcing a redirect. Does NOT enforce MFA — callers that care must check
 * `ctx.mfa_required && !ctx.mfa_verified` themselves. */
export async function getSession(): Promise<SessionContext | null> {
  const session = await auth();
  if (!session?.user) return null;
  return {
    user_id: session.user.user_id,
    email: session.user.email,
    role: session.user.role,
    employee_id: session.user.employee_id,
    mfa_required: session.user.mfa_required,
    mfa_enrolled: session.user.mfa_enrolled,
    mfa_verified: session.user.mfa_verified,
  };
}

/** Predicate-only check. Doesn't throw, doesn't redirect, just answers. */
export function hasRole(ctx: SessionContext, minRole: Role): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[minRole];
}
