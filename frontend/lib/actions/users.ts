"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { appUser, employeeCurrent } from "@/lib/db/schema";
import { audit } from "@/lib/auth/audit";
import {
  adminCreateCognitoUser,
  adminDeleteCognitoUser,
  adminDisableCognitoUser,
  adminEnableCognitoUser,
  adminGlobalSignOut,
  adminResendInvitation,
  adminResetPassword,
  adminUpdateUserGroup,
} from "@/lib/auth/cognito-admin";
import {
  ForbiddenError,
  invalidateDisabledCache,
  requireSession,
} from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/api/rate-limit";

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

  // Two paths:
  //
  //   - Dev mode: no Cognito to call. Synthesize a `dev:<email>` stub
  //     `cognito_sub`. The dev Credentials provider matches on email so
  //     the user can still sign in locally without round-tripping AWS.
  //
  //   - Prod: actually create the Cognito user via AdminCreateUser. Cognito
  //     sends the temp-password email itself; the user signs in via the
  //     hosted UI and is forced to set a permanent password (and enrol
  //     MFA — `mfa_configuration = "ON"` on the pool). Persist the real
  //     Cognito `sub` so the first-login `findOrCreateAppUser` match
  //     happens by `cognito_sub` (cheaper, no fallback needed).
  const isDev = process.env.AUTH_DEV_MODE === "true";
  let cognito_sub: string;
  if (isDev) {
    cognito_sub = `dev:${email.toLowerCase()}`;
  } else {
    try {
      const created = await adminCreateCognitoUser({ email, group: role });
      cognito_sub = created.sub;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UsernameExistsException")) {
        return err(
          "conflict",
          `Cognito already has a user for ${email}. ` +
            "If this is unexpected, an admin may have created the Cognito " +
            "user out-of-band; reconcile via the AWS console first.",
        );
      }
      return err(
        "internal_error",
        `Cognito AdminCreateUser failed: ${msg}`,
      );
    }
  }

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

  type RoleChange = {
    user_id: string;
    role: "admin" | "manager" | "employee";
    email: string;
    cognito_sub: string;
    previous_role: "admin" | "manager" | "employee";
  };
  type TxOutcome =
    | { kind: "ok"; data: RoleChange }
    | { kind: "last_admin_guard" }
    | { kind: "not_found" };

  // Return the outcome from the transaction directly so TypeScript can
  // narrow on a discriminated union. Reassigning a `let` inside the
  // callback breaks TS flow analysis after the await (sees only the
  // initializer, infers `never` after the null-check).
  const txOutcome: TxOutcome = await db.transaction(
    async (tx): Promise<TxOutcome> => {
      if (demotingSelf) {
        const admins = await tx
          .select({ user_id: appUser.user_id })
          .from(appUser)
          .where(eq(appUser.role, "admin"))
          .for("update");
        if (admins.length <= 1) return { kind: "last_admin_guard" };
      }
      // Capture current state before the update so we can sync Cognito
      // groups afterwards (need the OLD role for
      // AdminRemoveUserFromGroup + the email for both group calls +
      // the cognito_sub to know whether to skip the Cognito hop in
      // dev mode).
      const before = await tx
        .select({
          email: appUser.email,
          role: appUser.role,
          cognito_sub: appUser.cognito_sub,
        })
        .from(appUser)
        .where(eq(appUser.user_id, parsed.data.user_id))
        .limit(1);
      if (!before[0]) return { kind: "not_found" };
      const updated = await tx
        .update(appUser)
        .set(updates)
        .where(eq(appUser.user_id, parsed.data.user_id))
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
    },
  );

  if (txOutcome.kind === "last_admin_guard") {
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
  if (txOutcome.kind === "not_found") {
    await audit(ctx, {
      action: "user_role_change_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }

  const r = txOutcome.data;

  await audit(ctx, {
    action: "user_role_changed",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  // Sync Cognito groups so the user's NEXT sign-in lands on the new
  // role. The JWT callback reads `cognito:groups` as the source of
  // truth for token.role — without this update, a demoted admin
  // re-elevates the moment they sign in again.
  //
  // Then global-sign-out so their CURRENT session gets invalidated;
  // the user is bounced to /login and re-issued a token with the new
  // groups claim. Without sign-out the token survives until expiry
  // (up to 7 days) and `app_user.role` (in DB, which we just updated)
  // diverges from `token.role` (cached at sign-in time).
  //
  // Dev-mode stub users have no Cognito presence — skip both calls.
  const isDev = process.env.AUTH_DEV_MODE === "true";
  const isDevStub = r.cognito_sub.startsWith("dev:");
  if (!isDev && !isDevStub && r.previous_role !== r.role) {
    try {
      await adminUpdateUserGroup(
        r.email,
        r.previous_role,
        r.role,
      );
      await adminGlobalSignOut(r.email);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The DB is already updated. Surface the Cognito-side failure so
      // the operator can manually reconcile (or retry the action),
      // but the action did partially succeed.
      return err(
        "internal_error",
        `Role updated in DB but Cognito sync failed: ${msg}. Retry the action or run: aws cognito-idp admin-remove-user-from-group / admin-add-user-to-group / admin-user-global-sign-out manually.`,
      );
    }
  }

  revalidatePath("/settings/users");
  return ok({ user_id: r.user_id, role: r.role });
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

  // Capture email + cognito_sub before the update so we can mirror the
  // change in Cognito (AdminDisableUser + AdminUserGlobalSignOut).
  const before = await db
    .select({
      email: appUser.email,
      cognito_sub: appUser.cognito_sub,
    })
    .from(appUser)
    .where(eq(appUser.user_id, parsed.data.user_id))
    .limit(1);

  const updated = await db
    .update(appUser)
    .set({ is_disabled: parsed.data.disabled })
    .where(eq(appUser.user_id, parsed.data.user_id))
    .returning({
      user_id: appUser.user_id,
      is_disabled: appUser.is_disabled,
    });
  if (!updated[0] || !before[0]) {
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

  // Mirror the change in Cognito. Without this:
  //   - On disable, the user's existing Cognito tokens stay valid up
  //     to 7 days and any system that accepts them (not just our app)
  //     still treats them as signed-in.
  //   - On disable, the user could still complete in-flight OAuth
  //     flows initiated before the disable.
  //   - On enable, app_user.is_disabled flips but the user can't
  //     actually sign in if Cognito previously disabled them
  //     out-of-band — keeping the two states in sync prevents that
  //     divergence.
  // AdminDisableUser doesn't revoke tokens — only blocks new sign-ins
  // — so pair with AdminUserGlobalSignOut on disable.
  const isDev = process.env.AUTH_DEV_MODE === "true";
  const isDevStub = before[0].cognito_sub.startsWith("dev:");
  if (!isDev && !isDevStub) {
    try {
      if (parsed.data.disabled) {
        await adminDisableCognitoUser(before[0].email);
        await adminGlobalSignOut(before[0].email);
      } else {
        await adminEnableCognitoUser(before[0].email);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // DB is updated; surface the Cognito divergence so the operator
      // can reconcile. UnsupportedUserStateException = already in the
      // target state — treat as success.
      if (!msg.includes("UnsupportedUserStateException")) {
        return err(
          "internal_error",
          `${parsed.data.disabled ? "Disabled" : "Enabled"} in DB but Cognito sync failed: ${msg}.`,
        );
      }
    }
  }

  revalidatePath("/settings/users");
  return ok(updated[0]);
}

/* ---------- delete user ---------- */

const DeleteSchema = z.object({
  user_id: z.string().uuid(),
});

export async function deleteUserAction(
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
  // Scoped rate limit on the destructive admin actions. The global
  // ceiling already fired in requireSession; this `expensive` tier
  // (20/min) bounds how many users a compromised admin token can wipe
  // before the bucket runs dry. Same shape for resend + reset below.
  enforceRateLimit(ctx, "user_admin_delete", "expensive");
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (parsed.data.user_id === ctx.user_id) {
    await audit(ctx, {
      action: "user_delete_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("conflict", "You can't delete your own account.");
  }

  // Look up the email + disabled flag before deleting; we need the email
  // to call AdminDeleteUser, and the disabled flag to enforce the gate.
  const rows = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      is_disabled: appUser.is_disabled,
      cognito_sub: appUser.cognito_sub,
    })
    .from(appUser)
    .where(eq(appUser.user_id, parsed.data.user_id))
    .limit(1);
  const target = rows[0];
  if (!target) {
    await audit(ctx, {
      action: "user_delete_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }
  if (!target.is_disabled) {
    await audit(ctx, {
      action: "user_delete_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err(
      "conflict",
      "Disable the user before deleting. Delete is irreversible.",
    );
  }

  // Audit BEFORE deleting — the audit_log FK is `ON DELETE SET NULL`,
  // so the row survives, but we want the target_id captured while the
  // app_user row still exists.
  await audit(ctx, {
    action: "user_deleted",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  // Cognito first. If this fails the DB row stays put and we can retry.
  // The reverse order would leave Cognito in a state where the user
  // still exists but has no app_user row, which surfaces as a confusing
  // sign-in attempt landing on `findOrCreateAppUser`.
  const isDev = process.env.AUTH_DEV_MODE === "true";
  const isDevStub = target.cognito_sub.startsWith("dev:");
  if (!isDev && !isDevStub) {
    try {
      await adminDeleteCognitoUser(target.email);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("UserNotFoundException")) {
        return err(
          "internal_error",
          `Cognito AdminDeleteUser failed: ${msg}`,
        );
      }
      // already gone — proceed
    }
  }

  await db.delete(appUser).where(eq(appUser.user_id, parsed.data.user_id));

  revalidatePath("/settings/users");
  return ok({ user_id: parsed.data.user_id });
}

/* ---------- resend invitation ---------- */

const ResendSchema = z.object({
  user_id: z.string().uuid(),
});

export async function resendInvitationAction(
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
  // Each call sends a real Cognito email via SES — bound at 20/min so
  // a compromised admin token can't blast invitations / burn SES quota.
  enforceRateLimit(ctx, "user_admin_resend", "expensive");
  const parsed = ResendSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const rows = await db
    .select({ email: appUser.email, last_login_at: appUser.last_login_at })
    .from(appUser)
    .where(eq(appUser.user_id, parsed.data.user_id))
    .limit(1);
  const target = rows[0];
  if (!target) {
    await audit(ctx, {
      action: "user_invitation_resend_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }

  // RESEND only works for users in FORCE_CHANGE_PASSWORD — i.e. who
  // haven't signed in yet. Surfacing a friendly error here beats
  // forwarding Cognito's `NotAuthorizedException`.
  if (target.last_login_at) {
    await audit(ctx, {
      action: "user_invitation_resend_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err(
      "conflict",
      "This user has already signed in. Use Reset password instead.",
    );
  }

  try {
    await adminResendInvitation(target.email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err("internal_error", `Cognito RESEND failed: ${msg}`);
  }

  await audit(ctx, {
    action: "user_invitation_resent",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  return ok({ user_id: parsed.data.user_id });
}

/* ---------- admin password reset ---------- */

const ResetPasswordSchema = z.object({
  user_id: z.string().uuid(),
});

export async function resetPasswordAction(
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
  // Triggers AdminResetUserPassword → SES email + invalidates the
  // user's current password. Compromised admin token + a loop here =
  // every user locked out + SES quota gone. 20/min cap.
  enforceRateLimit(ctx, "user_admin_reset", "expensive");
  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const rows = await db
    .select({ email: appUser.email, last_login_at: appUser.last_login_at })
    .from(appUser)
    .where(eq(appUser.user_id, parsed.data.user_id))
    .limit(1);
  const target = rows[0];
  if (!target) {
    await audit(ctx, {
      action: "user_password_reset_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err("not_found", "User not found.");
  }

  // AdminResetUserPassword is for users who've completed first sign-in.
  // For never-signed-in users, RESEND the original temp-password email
  // instead — that's `resendInvitationAction`.
  if (!target.last_login_at) {
    await audit(ctx, {
      action: "user_password_reset_denied",
      target_type: "app_user",
      target_id: parsed.data.user_id,
    });
    return err(
      "conflict",
      "This user has never signed in. Use Send again instead.",
    );
  }

  try {
    await adminResetPassword(target.email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err("internal_error", `Cognito AdminResetUserPassword failed: ${msg}`);
  }

  await audit(ctx, {
    action: "user_password_reset",
    target_type: "app_user",
    target_id: parsed.data.user_id,
  });

  return ok({ user_id: parsed.data.user_id });
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
