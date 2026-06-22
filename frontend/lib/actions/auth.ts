"use server";

/** Auth-side Server Actions. Today: kill the Cognito refresh token at
 * sign-out so it can't be replayed for up to 7 days after the user
 * navigates away.
 *
 * Without this:
 *   1. Auth.js `signOut()` clears our cookie.
 *   2. The client redirects to Cognito's `/logout` which kills the IdP
 *      session cookie on `auth.<domain>`.
 *   3. BUT the refresh token Cognito issued at sign-in is still
 *      cryptographically valid — anyone who stole it before sign-out
 *      can keep minting access tokens against the user-pool client
 *      until the refresh token expires on its own (7 days by default).
 *
 * `RevokeTokenCommand` adds the token to Cognito's revocation list
 * immediately. Combined with `enable_token_revocation = true` on the
 * app client (verified in terraform/modules/cognito/main.tf), every
 * subsequent token-introspection call rejects it. */
import {
  CognitoIdentityProviderClient,
  RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { getCognitoRefreshToken } from "@/lib/auth/cognito-tokens";

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
      "Cannot determine Cognito region for RevokeTokenCommand.",
    );
  }
  cachedClient = new CognitoIdentityProviderClient({ region });
  return cachedClient;
}

/** Best-effort Cognito refresh-token revocation. Never throws — sign-out
 * must continue even if revocation fails. The client UI calls this
 * Server Action immediately before navigating to Cognito's `/logout`.
 *
 * No auth gate required: revocation needs the refresh token, which is
 * proof of possession. A caller without a refresh token is silently
 * no-op'd. Calling `RevokeToken` with a token you don't own is the
 * legitimate revocation path; Cognito returns success regardless. */
export async function revokeCognitoTokenAction(): Promise<void> {
  const refreshToken = await getCognitoRefreshToken();
  if (!refreshToken) return;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET;
  if (!clientId) return;
  try {
    await client().send(
      new RevokeTokenCommand({
        Token: refreshToken,
        ClientId: clientId,
        ClientSecret: clientSecret,
      }),
    );
  } catch {
    // Intentionally swallowed: a failed revocation must not block
    // sign-out (worse UX than the marginal benefit of revocation).
    // Cognito-side natural expiry is the fallback.
  }
}
