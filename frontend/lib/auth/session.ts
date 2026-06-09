/** Server-side session enforcement.
 *
 * `requireSession({ minRole })` is the single helper every Server
 * Component page, route handler, and Server Action calls at the top. It:
 *   - redirects to /login if there's no session
 *   - redirects to /login if the user has been disabled (was H-008)
 *   - redirects to /auth/mfa/* if MFA is pending
 *   - throws a 403 Forbidden if the user lacks the minimum role
 *   - returns a typed `SessionContext` for the page/action body
 *
 * The role hierarchy (admin > manager > employee) is checked numerically.
 * Pages that should be reachable by any signed-in user (employees
 * included) call `requireSession()` with no arg.
 */
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { appUser } from "@/lib/db/schema";

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

/** Tiny per-process cache of `is_disabled` so we don't pay a DB round-trip
 * on every protected request. 30s TTL is short enough that disabling a
 * user takes effect quickly (admin → fired user dropped within 30s) and
 * long enough that a logged-in user's hot path doesn't double-query the
 * DB just to confirm they're still allowed in.
 *
 * For a 40-user workload this Map peaks at 40 entries. Not worth Redis. */
const DISABLED_CACHE_TTL_MS = 30_000;
const disabledCache = new Map<string, { is_disabled: boolean; expires_at: number }>();

async function isUserDisabled(user_id: string): Promise<boolean> {
  const now = Date.now();
  const cached = disabledCache.get(user_id);
  if (cached && cached.expires_at > now) return cached.is_disabled;

  const [row] = await db
    .select({ is_disabled: appUser.is_disabled })
    .from(appUser)
    .where(eq(appUser.user_id, user_id))
    .limit(1);
  // Treat "user not in DB" as disabled. The only way that happens with a
  // valid JWT is a deleted account — defaulting to deny is safer.
  const is_disabled = row ? row.is_disabled : true;
  disabledCache.set(user_id, {
    is_disabled,
    expires_at: now + DISABLED_CACHE_TTL_MS,
  });
  return is_disabled;
}

/** Force a cache refresh for a specific user. Call from `setUserDisabledAction`
 * after toggling the flag so the change takes effect instantly rather than
 * waiting up to 30s for the cache to expire. */
export function invalidateDisabledCache(user_id: string): void {
  disabledCache.delete(user_id);
}

/** Use from a Server Component or Server Action. Redirects:
 *  - unauthenticated → /login
 *  - disabled account → /login (terminated employee, fired admin, etc.)
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
  // Active-revocation check: a JWT survives `setUserDisabledAction` for
  // up to 7 days otherwise. Bounce disabled users at every protected
  // request (was H-008 in the pre-launch pen test).
  if (await isUserDisabled(session.user.user_id)) {
    redirect("/login?error=disabled");
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
 * forcing a redirect. Does NOT enforce MFA or disabled-user checks — callers
 * that care must check `ctx.mfa_required && !ctx.mfa_verified` themselves. */
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

/** Check used by route-handler API enforcement. Same DB lookup +
 * cache as `requireSession`; the route-handler helper translates this
 * to a 401 instead of a redirect. */
export { isUserDisabled };
