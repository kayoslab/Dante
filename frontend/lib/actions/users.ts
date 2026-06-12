"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { appUser, employeeCurrent } from "@/lib/db/schema";
import { audit } from "@/lib/auth/audit";
import {
  ForbiddenError,
  invalidateDisabledCache,
  requireSession,
} from "@/lib/auth/session";

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

  // MFA is mandatory for everyone; nothing role-specific to set here.
  const updates: Record<string, unknown> = { role: parsed.data.role };

  // Wrap the last-admin check + the role write in a transaction with
  // `SELECT ... FOR UPDATE` on the admin rows. Two admins demoting each
  // other concurrently used to both pass the count check and both
  // succeed, leaving zero admins (was H-002 in the pre-launch pen test).
  // The row lock serializes the check.
  const demotingSelf =
    parsed.data.user_id === ctx.user_id && parsed.data.role !== "admin";

  let result: { user_id: string; role: "admin" | "manager" | "employee" } | null = null;
  let conflictReason: string | null = null;

  await db.transaction(async (tx) => {
    if (demotingSelf) {
      const admins = await tx
        .select({ user_id: appUser.user_id })
        .from(appUser)
        .where(eq(appUser.role, "admin"))
        .for("update");
      if (admins.length <= 1) {
        conflictReason = "last_admin_guard";
        return;
      }
    }
    const updated = await tx
      .update(appUser)
      .set(updates)
      .where(eq(appUser.user_id, parsed.data.user_id))
      .returning({ user_id: appUser.user_id, role: appUser.role });
    result = updated[0] ?? null;
  });

  if (conflictReason === "last_admin_guard") {
    // Audit the *attempt* — without this, repeated probing of
    // privilege-escalation endpoints leaves no trail (was H-006).
    await audit(ctx, {
      action: "user_role_change_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err(
      "conflict",
      "Refusing to demote the last remaining admin. Promote another user first.",
    );
  }
  if (!result) {
    await audit(ctx, {
      action: "user_role_change_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }

  await audit(ctx, {
    action: "user_role_changed",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  revalidatePath("/settings/users");
  return ok(result);
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
    await audit(ctx, {
      action: "user_disable_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
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
    await audit(ctx, {
      action: "user_disable_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }

  await audit(ctx, {
    action: parsed.data.disabled ? "user_disabled" : "user_enabled",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  // Bust the cache so the next protected request sees the new state
  // immediately, not after the 30s TTL.
  invalidateDisabledCache(parsed.data.user_id);

  revalidatePath("/settings/users");
  return ok(updated[0]);
}

/* ---------- reset MFA (lost device) ---------- */

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
