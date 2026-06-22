/** Cognito admin SDK wrapper.
 *
 * Operations here run with the ECS task role's AWS credentials (no user
 * access token), so they can act on behalf of any user in the pool. Use
 * sparingly — every export is an admin-only operation and the caller is
 * responsible for gating with `requireSession({ minRole: "admin" })`
 * before invoking.
 *
 * Region resolution mirrors `cognito-self-service.ts`: COGNITO_REGION
 * first, else parse out of the OIDC issuer URL, else fall back to
 * AWS_REGION. Same client gets cached across invocations.
 *
 * IAM: the task role needs `cognito-idp:AdminCreateUser`,
 * `cognito-idp:AdminAddUserToGroup`, etc. on the pool ARN — granted via
 * `aws_iam_role_policy.app_cognito_admin` in `terraform/envs/prod/main.tf`.
 */
import "server-only";

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminResetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import type { Role } from ".";

let cachedClient: CognitoIdentityProviderClient | null = null;
function client(): CognitoIdentityProviderClient {
  if (cachedClient) return cachedClient;
  const region =
    process.env.COGNITO_REGION ??
    process.env.COGNITO_ISSUER?.match(
      /cognito-idp\.([a-z0-9-]+)\.amazonaws\.com/,
    )?.[1] ??
    process.env.AWS_REGION;
  if (!region) {
    throw new Error(
      "Cannot determine Cognito region. Set COGNITO_REGION or COGNITO_ISSUER.",
    );
  }
  cachedClient = new CognitoIdentityProviderClient({ region });
  return cachedClient;
}

function userPoolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) {
    throw new Error(
      "COGNITO_USER_POOL_ID is not set. The ECS task definition must " +
        "inject it from the cognito module's output.",
    );
  }
  return id;
}

/** Create a new Cognito user and add them to the role group. Cognito
 * sends a temp-password email (`no-reply@verificationemail.com` until
 * SES is wired). The user signs in via the hosted UI, is forced to set
 * a permanent password, and enrolls MFA. Returns the new user's
 * Cognito `sub` (the UUID under which Auth.js will see them on
 * sign-in). */
export async function adminCreateCognitoUser(opts: {
  email: string;
  group: Role;
}): Promise<{ sub: string }> {
  const cmd = new AdminCreateUserCommand({
    UserPoolId: userPoolId(),
    Username: opts.email,
    UserAttributes: [
      { Name: "email", Value: opts.email },
      // Mark email_verified so Cognito doesn't push the user through
      // a separate confirm-email step — we already know it's good
      // because the admin typed it in.
      { Name: "email_verified", Value: "true" },
    ],
    DesiredDeliveryMediums: ["EMAIL"],
  });
  const res = await client().send(cmd);

  const sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) {
    throw new Error(
      `AdminCreateUser returned no sub attribute for ${opts.email}`,
    );
  }

  await client().send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId(),
      Username: opts.email,
      GroupName: opts.group,
    }),
  );

  return { sub };
}

/** Re-send the welcome / temp-password email for a user who hasn't
 * signed in yet (Cognito status `FORCE_CHANGE_PASSWORD`). Uses
 * AdminCreateUser with `MessageAction = RESEND` — Cognito reuses the
 * existing user record, generates a fresh temp password, and sends the
 * invitation email again.
 *
 * Cognito rejects this with `UserNotFoundException` if the user
 * doesn't exist, `NotAuthorizedException` if the user has already
 * completed the first sign-in (status != FORCE_CHANGE_PASSWORD), and
 * `UnsupportedUserStateException` on disabled accounts. Caller maps
 * those to friendly UI errors. */
export async function adminResendInvitation(email: string): Promise<void> {
  await client().send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId(),
      Username: email,
      MessageAction: "RESEND",
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );
}

/** Trigger Cognito's admin-initiated password reset. The user receives
 * a verification-code email and goes through the standard hosted-UI
 * forgot-password flow to pick a new password.
 *
 * Use for users who have already signed in at least once
 * (`CONFIRMED`); for `FORCE_CHANGE_PASSWORD` users use
 * `adminResendInvitation` instead, which re-sends the original temp
 * password rather than walking the reset flow. */
export async function adminResetPassword(email: string): Promise<void> {
  await client().send(
    new AdminResetUserPasswordCommand({
      UserPoolId: userPoolId(),
      Username: email,
    }),
  );
}

/** Hard-delete a Cognito user. Irreversible — every active session,
 * passkey, MFA registration, and group membership is wiped. The matching
 * `app_user` row should be removed in the same operation; otherwise the
 * email is "taken" but unsignable.
 *
 * Cognito returns success on already-deleted users (treated as
 * idempotent), so the caller doesn't need to pre-check existence. */
export async function adminDeleteCognitoUser(email: string): Promise<void> {
  await client().send(
    new AdminDeleteUserCommand({
      UserPoolId: userPoolId(),
      Username: email,
    }),
  );
}
