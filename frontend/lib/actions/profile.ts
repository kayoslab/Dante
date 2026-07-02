"use server";

/** Self-service profile actions backed by Cognito's user-pool APIs.
 *
 * Layout mirrors `lib/actions/users.ts` — Zod schema → require session
 * → call the SDK wrapper → audit. The Cognito-specific error mapping
 * lives in `mapCognitoError()` so the UI gets stable failure codes
 * ("invalid_password", "wrong_current_password", etc.) rather than the
 * raw SDK exception names.
 *
 * All actions return an `ActionResult` matching the rest of the
 * Server-Action layer. */
import { z } from "zod";

import { audit } from "@/lib/auth/audit";
import {
  changePassword,
  completePasskeyRegistration,
  deletePasskey,
  listPasskeys,
  setTotpPreference,
  startPasskeyRegistration,
  startTotpEnrollment,
  verifyTotpEnrollment,
} from "@/lib/auth/cognito-self-service";
import { CognitoReauthRequired } from "@/lib/auth/cognito-tokens";
import { requireSession } from "@/lib/auth/session";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Turn an SDK exception into a stable error code the UI can branch on.
 * The exception's `.name` (e.g. "NotAuthorizedException",
 * "InvalidPasswordException") is the only thing Cognito guarantees is
 * stable; the human messages drift. */
function mapCognitoError<T>(e: unknown): ActionResult<T> {
  if (e instanceof CognitoReauthRequired) {
    return err("forbidden", "Please sign in again to make this change.");
  }
  const name = (e as { name?: string }).name ?? "";
  const message = (e as { message?: string }).message ?? "";
  switch (name) {
    case "NotAuthorizedException":
      // Either the current password is wrong on ChangePassword, or the
      // access token has been revoked. The first is by far the common
      // case from a profile form.
      return err("validation_error", "Current password is incorrect.");
    case "InvalidPasswordException":
      return err(
        "validation_error",
        message || "New password doesn't meet the policy.",
      );
    case "LimitExceededException":
      return err(
        "rate_limited" as never,
        "Too many attempts. Try again in a few minutes.",
      );
    case "CodeMismatchException":
      return err("validation_error", "Verification code didn't match.");
    case "ResourceNotFoundException":
      return err("not_found", "Resource not found.");
    default:
      return err(
        "internal_error",
        message ? `Cognito: ${name || "unknown"}` : "Internal error.",
      );
  }
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, "Current password is required."),
  new_password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(256),
});

export async function changePasswordAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession();
  const parsed = ChangePasswordSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await changePassword(
      parsed.data.current_password,
      parsed.data.new_password,
    );
  } catch (e) {
    return mapCognitoError(e);
  }
  await audit(ctx, {
    action: "self_password_changed",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export async function startTotpEnrollmentAction(): Promise<
  ActionResult<{ secret: string; otpauth_url: string }>
> {
  const ctx = await requireSession();
  try {
    const { secret } = await startTotpEnrollment();
    // Compose the standard otpauth URI the UI renders as a QR code. We
    // don't fetch it from Cognito because Cognito only returns the
    // secret, not a URI — and the URI format is fixed RFC convention.
    const otpauth_url =
      `otpauth://totp/${encodeURIComponent("Dante")}:${encodeURIComponent(ctx.email)}` +
      `?secret=${secret}&issuer=Dante&algorithm=SHA1&digits=6&period=30`;
    return ok({ secret, otpauth_url });
  } catch (e) {
    return mapCognitoError(e);
  }
}

const VerifyTotpSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, "Code must be 6 digits."),
});

export async function confirmTotpEnrollmentAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession();
  const parsed = VerifyTotpSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await verifyTotpEnrollment(parsed.data.code);
    await setTotpPreference(true);
  } catch (e) {
    return mapCognitoError(e);
  }
  await audit(ctx, {
    action: "self_totp_enabled",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn)
// ---------------------------------------------------------------------------

/** Step 1 — mint CredentialCreationOptions for the browser ceremony.
 * The options are opaque JSON from Cognito; the client decodes the
 * base64url binary fields before calling navigator.credentials.create. */
export async function startPasskeyEnrollmentAction(): Promise<
  ActionResult<{ options: unknown }>
> {
  await requireSession();
  try {
    const options = await startPasskeyRegistration();
    return ok({ options });
  } catch (e) {
    return mapCognitoError(e);
  }
}

// The completed credential is arbitrary WebAuthn JSON — we don't
// re-validate its shape (Cognito is the authority and rejects a
// malformed attestation). We only assert it's a non-null object so a
// obviously-broken client payload fails fast with a clean message.
const CompletePasskeySchema = z.object({
  credential: z.record(z.string(), z.unknown()),
});

export async function completePasskeyEnrollmentAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession();
  const parsed = CompletePasskeySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await completePasskeyRegistration(parsed.data.credential);
  } catch (e) {
    return mapCognitoError(e);
  }
  await audit(ctx, {
    action: "self_passkey_registered",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}

const DeletePasskeySchema = z.object({
  credential_id: z.string().min(1),
});

export async function deletePasskeyAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const ctx = await requireSession();
  const parsed = DeletePasskeySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await deletePasskey(parsed.data.credential_id);
  } catch (e) {
    return mapCognitoError(e);
  }
  await audit(ctx, {
    action: "self_passkey_deleted",
    target_type: "user",
    target_id: ctx.user_id,
  });
  return ok(null);
}

/** Re-list passkeys after a mutation so the client can refresh without a
 * full page reload. */
export async function listPasskeysAction(): Promise<
  ActionResult<{ passkeys: Awaited<ReturnType<typeof listPasskeys>> }>
> {
  await requireSession();
  try {
    const passkeys = await listPasskeys();
    return ok({ passkeys });
  } catch (e) {
    return mapCognitoError(e);
  }
}

