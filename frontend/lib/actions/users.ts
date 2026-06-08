"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { appUser, employeeCurrent } from "@/lib/db/schema";
import { audit } from "@/lib/auth/audit";
import { ForbiddenError, requireSession } from "@/lib/auth/session";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";

/* ---------- shared admin gate ---------- */

async function requireAdmin() {
  try {
    return await requireSession({ minRole: "admin" });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      throw new Error("forbidden");
    }
    throw e;
  }
}

function bailForbidden<T>(e: unknown): ActionResult<T> | null {
  if (e instanceof Error && e.message === "forbidden") {
    return err("forbidden", "Only admins can perform this action.");
  }
  return null;
}

/* ---------- invite ---------- */

const InviteSchema = z.object({
  email: z.string().email().transform((s) => s.trim()),
  role: z.enum(["admin", "manager", "employee"]).default("employee"),
});

export type InvitedUser = {
  user_id: string;
  email: string;
  role: "admin" | "manager" | "employee";
};

export async function inviteUserAction(
  input: unknown,
): Promise<ActionResult<InvitedUser>> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    const f = bailForbidden<InvitedUser>(e);
    if (f) return f;
    throw e;
  }
  const parsed = InviteSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { email, role } = parsed.data;

  // Reject duplicates (the unique index would too, but a friendly error
  // is nicer than a Postgres constraint message).
  const dup = await db
    .select({ user_id: appUser.user_id })
    .from(appUser)
    .where(sql`LOWER(${appUser.email}) = ${email.toLowerCase()}`)
    .limit(1);
  if (dup[0]) {
    return err("conflict", `A user with email ${email} already exists.`);
  }

  // Auto-link to employee_current by exact email match.
  const empMatch = await db
    .select({ employee_id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(sql`LOWER(${employeeCurrent.email}) = ${email.toLowerCase()}`)
    .limit(1);

  // In dev mode we synthesize the cognito_sub. In prod this will be
  // replaced by a call to Cognito's AdminCreateUser, then the row gets
  // updated with the real sub. The temp-password email goes out from
  // Cognito; the user signs in and changes it.
  const cognito_sub = `dev:${email.toLowerCase()}`;
  const inserted = await db
    .insert(appUser)
    .values({
      cognito_sub,
      email,
      role,
      employee_id: empMatch[0]?.employee_id ?? null,
      // admin + manager invitations default to MFA-required. Employees
      // can opt in via /profile later.
      mfa_required: role !== "employee",
    })
    .returning({
      user_id: appUser.user_id,
      email: appUser.email,
      role: appUser.role,
    });

  await audit(ctx, {
    action: "user_invited",
    target_type: "app_user",
    target_id: inserted[0].user_id,
  });

  revalidatePath("/settings/users");
  return ok({ ...inserted[0] });
}

/* ---------- change role ---------- */

const SetRoleSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["admin", "manager", "employee"]),
});

export async function setUserRoleAction(
  input: unknown,
): Promise<ActionResult<{ user_id: string; role: "admin" | "manager" | "employee" }>> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    const f = bailForbidden<{
      user_id: string;
      role: "admin" | "manager" | "employee";
    }>(e);
    if (f) return f;
    throw e;
  }
  const parsed = SetRoleSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  // Guard against an admin demoting themselves while there's only one admin.
  if (parsed.data.user_id === ctx.user_id && parsed.data.role !== "admin") {
    const adminCount = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(appUser)
      .where(eq(appUser.role, "admin"));
    if ((adminCount[0]?.count ?? 0) <= 1) {
      return err(
        "conflict",
        "Refusing to demote the last remaining admin. Promote another user first.",
      );
    }
  }

  // Promoting an employee → manager/admin should force MFA on. Demoting
  // does not auto-clear `mfa_required` — keeping the stronger setting is
  // safer than silently weakening it; admins can flip it off explicitly.
  const updates: Record<string, unknown> = { role: parsed.data.role };
  if (parsed.data.role !== "employee") {
    updates.mfa_required = true;
  }
  const updated = await db
    .update(appUser)
    .set(updates)
    .where(eq(appUser.user_id, parsed.data.user_id))
    .returning({ user_id: appUser.user_id, role: appUser.role });
  if (!updated[0]) {
    return err("not_found", "User not found.");
  }

  await audit(ctx, {
    action: "user_role_changed",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  revalidatePath("/settings/users");
  return ok(updated[0]);
}

/* ---------- disable / enable ---------- */

const SetDisabledSchema = z.object({
  user_id: z.string().uuid(),
  disabled: z.boolean(),
});

export async function setUserDisabledAction(
  input: unknown,
): Promise<ActionResult<{ user_id: string; is_disabled: boolean }>> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    const f = bailForbidden<{ user_id: string; is_disabled: boolean }>(e);
    if (f) return f;
    throw e;
  }
  const parsed = SetDisabledSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (parsed.data.user_id === ctx.user_id && parsed.data.disabled) {
    return err("conflict", "You can't disable your own account.");
  }

  const updated = await db
    .update(appUser)
    .set({ is_disabled: parsed.data.disabled })
    .where(eq(appUser.user_id, parsed.data.user_id))
    .returning({
      user_id: appUser.user_id,
      is_disabled: appUser.is_disabled,
    });
  if (!updated[0]) {
    return err("not_found", "User not found.");
  }

  await audit(ctx, {
    action: parsed.data.disabled ? "user_disabled" : "user_enabled",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  revalidatePath("/settings/users");
  return ok(updated[0]);
}

/* ---------- reset MFA (lost device) ---------- */

const ResetMfaSchema = z.object({
  user_id: z.string().uuid(),
});

/** Admin-only: clear a user's TOTP secret + enrollment timestamp. The
 * user goes through `/auth/mfa/setup` on next sign-in. Use when a phone
 * is lost or a fresh authenticator app is needed. */
export async function resetUserMfaAction(
  input: unknown,
): Promise<ActionResult<{ user_id: string }>> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    const f = bailForbidden<{ user_id: string }>(e);
    if (f) return f;
    throw e;
  }
  const parsed = ResetMfaSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const updated = await db
    .update(appUser)
    .set({ mfa_secret: null, mfa_enrolled_at: null })
    .where(eq(appUser.user_id, parsed.data.user_id))
    .returning({ user_id: appUser.user_id });
  if (!updated[0]) return err("not_found", "User not found.");

  await audit(ctx, {
    action: "user_mfa_reset",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  revalidatePath("/settings/users");
  return ok(updated[0]);
}

/* ---------- link to employee ---------- */

const LinkEmployeeSchema = z.object({
  user_id: z.string().uuid(),
  employee_id: z.number().int().nullable(),
});

export async function setUserEmployeeAction(
  input: unknown,
): Promise<ActionResult<{ user_id: string; employee_id: number | null }>> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    const f = bailForbidden<{ user_id: string; employee_id: number | null }>(e);
    if (f) return f;
    throw e;
  }
  const parsed = LinkEmployeeSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const updated = await db
    .update(appUser)
    .set({ employee_id: parsed.data.employee_id })
    .where(eq(appUser.user_id, parsed.data.user_id))
    .returning({
      user_id: appUser.user_id,
      employee_id: appUser.employee_id,
    });
  if (!updated[0]) return err("not_found", "User not found.");

  await audit(ctx, {
    action: "user_employee_linked",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  revalidatePath("/settings/users");
  return ok(updated[0]);
}
