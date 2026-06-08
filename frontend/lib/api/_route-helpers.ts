/** Shared helpers for Next.js route handlers: HTTP error envelope + auth. */
import { NextResponse } from "next/server";

import { auth, type Role } from "@/lib/auth";
import { ROLE_RANK, type SessionContext } from "@/lib/auth/session";
import { log } from "@/lib/logger";

export type ErrorCode =
  | "internal_error"
  | "not_found"
  | "conflict"
  | "has_children"
  | "validation_error"
  | "unauthorized"
  | "forbidden";

export class HTTPError extends Error {
  status: number;
  code: ErrorCode;
  constructor(message: string, status: number, code: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const NotFound = (message: string) =>
  new HTTPError(message, 404, "not_found");
export const Conflict = (message: string) =>
  new HTTPError(message, 409, "conflict");
export const ChildrenExist = (message: string) =>
  new HTTPError(message, 409, "has_children");
export const Validation = (message: string) =>
  new HTTPError(message, 422, "validation_error");
export const Unauthorized = (message = "Sign in required") =>
  new HTTPError(message, 401, "unauthorized");
export const Forbidden = (message = "Forbidden") =>
  new HTTPError(message, 403, "forbidden");

/** Compatibility alias — historical name. Prefer `SessionContext` from
 * `@/lib/auth/session` in new code. */
export type ApiSessionContext = SessionContext;

/** Route-handler equivalent of `requireSession`. Throws `HTTPError(401)`
 * if there's no session, `HTTPError(403)` if the role is below `minRole`,
 * and `HTTPError(403, "mfa_required")` if the user hasn't completed MFA.
 * The surrounding `handle()` turns those into JSON responses with the
 * right status code.
 *
 * Use from EVERY API route. The proxy enforces "signed in or not" but
 * does not enforce roles or MFA — the per-route check is what keeps an
 * employee from hitting `/api/salary/*` and what keeps an MFA-pending
 * admin from reading data before completing TOTP.
 */
export async function requireApiSession(opts: {
  minRole?: Role;
  allowMfaPending?: boolean;
} = {}): Promise<SessionContext> {
  const session = await auth();
  if (!session?.user) {
    throw Unauthorized();
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
    throw Forbidden("MFA verification required");
  }
  if (opts.minRole && ROLE_RANK[ctx.role] < ROLE_RANK[opts.minRole]) {
    throw Forbidden(
      `requires role ${opts.minRole} or above (you are ${ctx.role})`,
    );
  }
  return ctx;
}

/** Wrap a route handler body. Catches HTTPError → JSON envelope; bubbles
 * everything else as a 500 with the same shape. */
export async function handle(
  fn: () => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof HTTPError) {
      return NextResponse.json(
        { detail: err.message, code: err.code },
        { status: err.status },
      );
    }
    log.error("route_unhandled", { err });
    return NextResponse.json(
      {
        detail: err instanceof Error ? err.message : "internal_error",
        code: "internal_error" as ErrorCode,
      },
      { status: 500 },
    );
  }
}
