"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { unstable_update as updateSession } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { generateEnrollment, verifyCode } from "@/lib/auth/mfa";
import { requireSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { appUser } from "@/lib/db/schema";

import { err, fromZod, ok, type ActionResult } from "./_action-helpers";

const CodeSchema = z.object({
  code: z.string().min(6).max(10),
});

const EnrollSchema = z.object({
  // The secret was shown to the user during setup; they post it back so
  // we don't need to persist intermediate state in a setup-session table.
  secret: z.string().min(16).max(64),
  code: z.string().min(6).max(10),
});

/** Page-load helper: generate a fresh secret + QR code. The secret is
 * NOT persisted yet — it lives in the form's hidden input until the
 * user proves possession by submitting a matching code. */
export async function startMfaEnrollmentAction(): Promise<
  ActionResult<{ secret: string; qr_data_url: string; otpauth_url: string }>
> {
  const ctx = await requireSession({ allowMfaPending: true });
  if (ctx.mfa_enrolled) {
    return err("conflict", "MFA is already enrolled. Ask an admin to reset it first.");
  }
  const enrollment = await generateEnrollment(ctx.email);
  return ok(enrollment);
}

/** Complete the setup: verify the code matches the secret, persist the
 * secret + enrollment timestamp, and flip `mfa_enrolled` + `mfa_verified`
 * on the JWT so the user can proceed without a second prompt. */
export async function completeMfaEnrollmentAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession({ allowMfaPending: true });
  const parsed = EnrollSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!verifyCode(parsed.data.secret, parsed.data.code)) {
    return err("validation_error", "Code didn't match. Try again.");
  }

  await db
    .update(appUser)
    .set({
      mfa_secret: parsed.data.secret,
      mfa_enrolled_at: new Date(),
    })
    .where(eq(appUser.user_id, ctx.user_id));

  await updateSession({
    user: {
      // Auth.js v5 ignores fields it doesn't know — we use this as a
      // typed message to the jwt callback's `trigger === "update"` path.
      mfa_enrolled: true,
      mfa_verified: true,
    } as never,
  } as never);

  await audit(ctx, {
    action: "mfa_enrolled",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}

/** Verify a code against the stored secret and flip `mfa_verified` for
 * this session. Doesn't reset the JWT expiry. */
export async function verifyMfaAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession({ allowMfaPending: true });
  const parsed = CodeSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!ctx.mfa_enrolled) {
    return err("conflict", "MFA isn't enrolled yet.");
  }

  // Pull the stored secret server-side so the client never sees it.
  const [row] = await db
    .select({ mfa_secret: appUser.mfa_secret })
    .from(appUser)
    .where(eq(appUser.user_id, ctx.user_id))
    .limit(1);
  if (!row?.mfa_secret) {
    return err("conflict", "MFA secret missing — ask an admin to reset.");
  }

  if (!verifyCode(row.mfa_secret, parsed.data.code)) {
    await audit(ctx, {
      action: "mfa_verify_failed",
      target_type: "user",
      target_id: ctx.user_id,
    });
    return err("validation_error", "Code didn't match. Try again.");
  }

  await updateSession({
    user: { mfa_verified: true } as never,
  } as never);

  await audit(ctx, {
    action: "mfa_verified",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}
