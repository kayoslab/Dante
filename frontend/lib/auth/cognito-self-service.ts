/** Cognito self-service SDK wrapper.
 *
 * Every function here takes the current user's Cognito access token
 * (fetched via `getCognitoAccessToken()` from `cognito-tokens.ts`) and
 * calls the corresponding `cognito-idp` API. Server Actions in
 * `lib/actions/profile.ts` wrap these with Zod parsing + audit logging.
 *
 * Region note: the Cognito IdP API is regional. We hard-pin to the same
 * region as the user pool — pulled from `COGNITO_REGION` or, as a
 * fallback, derived from the `COGNITO_ISSUER` URL. */
import {
  AssociateSoftwareTokenCommand,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  CompleteWebAuthnRegistrationCommand,
  DeleteWebAuthnCredentialCommand,
  GetUserCommand,
  ListWebAuthnCredentialsCommand,
  SetUserMFAPreferenceCommand,
  StartWebAuthnRegistrationCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { getCognitoAccessToken } from "./cognito-tokens";

/** Derive region from COGNITO_REGION first, else parse out of the OIDC
 * issuer URL (`https://cognito-idp.eu-central-1.amazonaws.com/<pool>`).
 * Cached because every call rebuilds the same client. */
let cachedClient: CognitoIdentityProviderClient | null = null;
function client(): CognitoIdentityProviderClient {
  if (cachedClient) return cachedClient;
  const region =
    process.env.COGNITO_REGION ??
    process.env.COGNITO_ISSUER?.match(/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com/)?.[1] ??
    process.env.AWS_REGION;
  if (!region) {
    throw new Error(
      "Cannot determine Cognito region. Set COGNITO_REGION or COGNITO_ISSUER.",
    );
  }
  cachedClient = new CognitoIdentityProviderClient({ region });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/** Cognito's `ChangePassword` — requires the user to provide their
 * current password. Throws on validation failure (wrong old password,
 * doesn't meet policy, etc.). Caller maps the SDK error to a user-facing
 * message. */
export async function changePassword(
  current_password: string,
  new_password: string,
): Promise<void> {
  const AccessToken = await getCognitoAccessToken();
  await client().send(
    new ChangePasswordCommand({
      AccessToken,
      PreviousPassword: current_password,
      ProposedPassword: new_password,
    }),
  );
}

// ---------------------------------------------------------------------------
// WebAuthn / passkeys
// ---------------------------------------------------------------------------

export type PasskeySummary = {
  credential_id: string;
  friendly_name: string | null;
  created_at: string | null;
  authenticator_attachment: string | null;
};

/** List all WebAuthn credentials on the signed-in user's account. */
export async function listPasskeys(): Promise<PasskeySummary[]> {
  const AccessToken = await getCognitoAccessToken();
  const res = await client().send(
    new ListWebAuthnCredentialsCommand({ AccessToken }),
  );
  const creds = res.Credentials ?? [];
  return creds.map((c) => ({
    credential_id: c.CredentialId ?? "",
    friendly_name: c.FriendlyCredentialName ?? null,
    created_at: c.CreatedAt?.toISOString() ?? null,
    authenticator_attachment: c.AuthenticatorAttachment ?? null,
  }));
}

/** Step 1 of passkey registration. Returns the WebAuthn
 * `PublicKeyCredentialCreationOptions` JSON that the browser feeds into
 * `navigator.credentials.create()`. */
export async function startPasskeyRegistration(): Promise<unknown> {
  const AccessToken = await getCognitoAccessToken();
  const res = await client().send(
    new StartWebAuthnRegistrationCommand({ AccessToken }),
  );
  return res.CredentialCreationOptions ?? null;
}

/** Step 2 of passkey registration. The browser hands back the
 * `PublicKeyCredential` from `navigator.credentials.create()`; we
 * forward it as-is to Cognito to persist. */
export async function completePasskeyRegistration(
  credential: Record<string, unknown>,
): Promise<void> {
  const AccessToken = await getCognitoAccessToken();
  // Cognito expects the credential as a `DocumentType` (free-form JSON).
  // The shape comes verbatim from `navigator.credentials.create()` →
  // PublicKeyCredential's `toJSON()` and is opaque to us; we just forward.
  await client().send(
    new CompleteWebAuthnRegistrationCommand({
      AccessToken,
      Credential: credential as never,
    }),
  );
}

/** Remove a registered passkey by its credential ID. */
export async function deletePasskey(credential_id: string): Promise<void> {
  const AccessToken = await getCognitoAccessToken();
  await client().send(
    new DeleteWebAuthnCredentialCommand({
      AccessToken,
      CredentialId: credential_id,
    }),
  );
}

// ---------------------------------------------------------------------------
// TOTP (software token MFA)
// ---------------------------------------------------------------------------

/** Whether the user has the TOTP factor enabled today. We branch the
 * profile UI on this — "Set up authenticator" vs. "Disable
 * authenticator". The Cognito reply lists every active factor in
 * `UserMFASettingList`; we just check for the TOTP entry. */
export async function getTotpEnabled(): Promise<boolean> {
  const AccessToken = await getCognitoAccessToken();
  const res = await client().send(new GetUserCommand({ AccessToken }));
  return (res.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA");
}

/** Step 1 of TOTP setup. Returns a base32 secret that the user feeds
 * into their authenticator app (and that we render as a QR via an
 * `otpauth://` URL composed client-side). */
export async function startTotpEnrollment(): Promise<{ secret: string }> {
  const AccessToken = await getCognitoAccessToken();
  const res = await client().send(
    new AssociateSoftwareTokenCommand({ AccessToken }),
  );
  if (!res.SecretCode) {
    throw new Error("Cognito did not return a TOTP secret.");
  }
  return { secret: res.SecretCode };
}

/** Step 2 of TOTP setup — verify the first 6-digit code. On success,
 * caller must also call `setTotpPreference(true)` to actually enable
 * TOTP as the MFA method. */
export async function verifyTotpEnrollment(
  code: string,
  friendly_device_name = "Authenticator",
): Promise<void> {
  const AccessToken = await getCognitoAccessToken();
  const res = await client().send(
    new VerifySoftwareTokenCommand({
      AccessToken,
      UserCode: code,
      FriendlyDeviceName: friendly_device_name,
    }),
  );
  if (res.Status !== "SUCCESS") {
    throw new Error(`TOTP verification failed: ${res.Status}`);
  }
}

/** Toggle TOTP MFA on/off for the user. Note that the user pool is
 * configured with `mfa_configuration = "ON"` — Cognito requires at
 * least one factor enabled, so we never let the user disable TOTP
 * unless they have a passkey registered. The caller checks that. */
export async function setTotpPreference(enabled: boolean): Promise<void> {
  const AccessToken = await getCognitoAccessToken();
  await client().send(
    new SetUserMFAPreferenceCommand({
      AccessToken,
      SoftwareTokenMfaSettings: {
        Enabled: enabled,
        PreferredMfa: enabled,
      },
    }),
  );
}
