/** Shared helpers for Next.js route handlers: HTTP error envelope + auth. */
import { NextResponse } from "next/server";

import { auth, type Role } from "@/lib/auth";
import { ROLE_RANK, isUserDisabled, type SessionContext } from "@/lib/auth/session";
import { log } from "@/lib/logger";

export type ErrorCode =
  | "internal_error"
  | "not_found"
  | "conflict"
  | "has_children"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "rate_limited";

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
 * if there's no session and `HTTPError(403)` if the role is below
 * `minRole`. The surrounding `handle()` turns those into JSON responses
 * with the right status code.
 *
 * MFA is enforced by Cognito's hosted UI before we ever see a token —
 * if the user pool's `mfa_configuration = "ON"`, the IdP guarantees
 * the JWT we receive comes from an MFA-verified sign-in. No in-app gate.
 *
 * Use from EVERY API route. The proxy enforces "signed in or not" but
 * does not enforce roles — the per-route check is what keeps an
 * employee from hitting `/api/salary/*`.
 */
export async function requireApiSession(opts: {
  minRole?: Role;
} = {}): Promise<SessionContext> {
  const session = await auth();
  if (!session?.user) {
    throw Unauthorized();
  }
  // Active-revocation check: disabled users keep a valid JWT for up to
  // 7 days. The cached DB lookup catches them at the API boundary (was
  // H-008 in the pre-launch pen test).
  if (await isUserDisabled(session.user.user_id)) {
    throw Unauthorized("Account disabled");
  }
  const ctx: SessionContext = {
    user_id: session.user.user_id,
    email: session.user.email,
    role: session.user.role,
    employee_id: session.user.employee_id,
  };
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
    // Log the real error server-side so operators can debug; return a
    // generic message to the client. Raw `err.message` would leak
    // Postgres constraint names ("duplicate key value violates unique
    // constraint app_user_email_idx"), table names, and other internal
    // schema details. Was M-005 in the pre-launch pen test.
    log.error("route_unhandled", { err });
    return NextResponse.json(
      {
        detail: "Internal server error.",
        code: "internal_error" as ErrorCode,
      },
      { status: 500 },
    );
  }
}
