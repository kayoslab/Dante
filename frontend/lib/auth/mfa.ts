/** TOTP (RFC 6238) helpers for the in-app MFA flow.
 *
 * No Cognito MFA — we run TOTP in the Node runtime so the experience is
 * the same in dev (Credentials provider) and prod (Cognito OIDC). Users
 * enroll once via Authenticator / 1Password / similar; the 6-digit codes
 * are verified server-side against the row in `app_user.mfa_secret`.
 *
 * Why not Cognito SOFTWARE_TOKEN_MFA: it requires Auth.js to handle
 * Cognito's MFA challenge flow, which means a custom credentials provider
 * on top of the OIDC one. Workable but a bigger surface. In-app TOTP is
 * one library + one column.
 *
 * Recovery (lost device): an admin clears `mfa_secret` + `mfa_enrolled_at`
 * for the affected user via `/settings/users`. The user goes through
 * setup again on next sign-in. See AGENTS.md for the runbook.
 */
import { authenticator } from "otplib";
import QRCode from "qrcode";

// 30s step, 1-step tolerance window (±30s) — standard.
authenticator.options = { step: 30, window: 1 };

const ISSUER = "Dante";

export type EnrollmentChallenge = {
  /** Base32 secret to persist on `app_user.mfa_secret` once the user
   * proves they captured it (by submitting a correct 6-digit code). */
  secret: string;
  /** otpauth:// URI — what the QR code encodes. */
  otpauth_url: string;
  /** Data URL of the QR PNG. Render directly in an <img>. */
  qr_data_url: string;
};

/** Create an enrollment payload for a new user. Does NOT persist —
 * caller decides when (typically after the user verifies the first code). */
export async function generateEnrollment(
  email: string,
): Promise<EnrollmentChallenge> {
  const secret = authenticator.generateSecret();
  const otpauth_url = authenticator.keyuri(email, ISSUER, secret);
  const qr_data_url = await QRCode.toDataURL(otpauth_url, {
    margin: 1,
    width: 220,
  });
  return { secret, otpauth_url, qr_data_url };
}

/** Verify a 6-digit code against a stored secret. Tolerates ±30s clock
 * skew via `authenticator.options.window = 1`. */
export function verifyCode(secret: string, code: string): boolean {
  // otplib rejects non-numeric input; trimming first lets us accept the
  // user's pasted code with whitespace without surfacing the error.
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.check(cleaned, secret);
  } catch {
    return false;
  }
}
