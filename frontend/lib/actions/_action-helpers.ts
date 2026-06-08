import type { ZodError } from "zod";

import {
  ForbiddenError,
  requireSession,
  type SessionContext,
} from "@/lib/auth/session";
import type { Role } from "@/lib/auth";

export type ActionErrorCode =
  | "internal_error"
  | "not_found"
  | "conflict"
  | "has_children"
  | "validation_error"
  | "forbidden";

export type ActionError = {
  detail: string;
  code: ActionErrorCode;
};

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

export const err = <T = never>(
  code: ActionErrorCode,
  detail: string,
): ActionResult<T> => ({ ok: false, error: { code, detail } });

export const fromZod = <T = never>(zerr: ZodError): ActionResult<T> =>
  err(
    "validation_error",
    zerr.issues[0]?.message ?? "validation error",
  );

export type ActionAuth =
  | { ok: true; ctx: SessionContext }
  // `result` is the failure half of ActionResult<T> for ANY T — TS lets
  // callers return it directly from a function declared `ActionResult<X>`
  // because the discriminant matches.
  | { ok: false; result: { ok: false; error: ActionError } };

/** Auth gate for Server Actions. Returns a discriminated union so the
 * caller can early-return the error path directly:
 *
 *   const auth = await requireActionRole("manager");
 *   if (!auth.ok) return auth.result;
 *   const ctx = auth.ctx;
 *
 * `requireSession` itself throws — we catch `ForbiddenError` and convert
 * to an `ActionResult` so the client sees a structured error instead of
 * the global error boundary. Unauthenticated callers still redirect to
 * /login (the throw bubbles up). */
export async function requireActionRole(minRole: Role): Promise<ActionAuth> {
  try {
    const ctx = await requireSession({ minRole });
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return {
        ok: false,
        result: {
          ok: false,
          error: { code: "forbidden", detail: `Requires role ${minRole} or above.` },
        },
      };
    }
    throw e;
  }
}
