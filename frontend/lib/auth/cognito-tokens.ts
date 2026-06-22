/** Server-side access to the Cognito OAuth tokens that the jwt callback
 * persisted on the Auth.js JWT.
 *
 * We deliberately don't surface the tokens via the `Session` callback —
 * anything on `session.user` ends up serialized to the client over
 * `/api/auth/session`, where any XSS could read it. Instead, this
 * module decodes the JWT cookie directly via `getToken()` from
 * `@auth/core/jwt`, which runs entirely server-side.
 *
 * Used by `lib/auth/cognito-self-service.ts` and the profile-related
 * Server Actions in `lib/actions/profile.ts`. */
import { headers } from "next/headers";
import { getToken } from "@auth/core/jwt";
import type { JWT } from "@auth/core/jwt";

/** Auth.js cookie names follow `__Secure-` in production (HTTPS) and
 * the unprefixed form in dev. Keeping both here lets dev and prod share
 * this file. */
const COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

/** Thrown when there's no Cognito access token to use — either the user
 * isn't signed in via Cognito (e.g. dev mode), the JWT cookie is missing,
 * or the refresh token has been rejected. Callers surface this as a
 * "please re-sign-in" prompt in the UI. */
export class CognitoReauthRequired extends Error {
  constructor(reason: string) {
    super(`Cognito re-auth required: ${reason}`);
    this.name = "CognitoReauthRequired";
  }
}

/** Read the raw JWT from the encrypted Auth.js cookie. Returns null when
 * the cookie is missing — does NOT throw, so dev-mode callers (no
 * Cognito session) can distinguish "not signed in via Cognito" from
 * "Cognito session expired". */
async function readJwt(): Promise<JWT | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — cannot decode JWT.");
  }
  const h = await headers();
  // getToken expects a Request-shaped object with a `headers` property.
  // We forward the incoming Headers so it can read the Cookie header
  // (including auto-chunked `…session-token.0`, `…session-token.1`).
  const req = new Request("http://internal/", { headers: h });
  return getToken({
    req,
    secret,
    salt: COOKIE_NAME,
    cookieName: COOKIE_NAME,
    secureCookie: process.env.NODE_ENV === "production",
  });
}

/** Get a Cognito access token guaranteed to be valid right now. Throws
 * `CognitoReauthRequired` for every "not available" case so callers
 * only need one catch path:
 *   - dev mode (no Cognito session at all)
 *   - JWT cookie missing
 *   - refresh-token exchange failed previously (jwt callback flipped
 *     `cognito_refresh_failed`)
 *   - access token field not set (shouldn't happen in prod, defensive) */
export async function getCognitoAccessToken(): Promise<string> {
  const jwt = await readJwt();
  if (!jwt) throw new CognitoReauthRequired("no JWT");
  if (jwt.cognito_refresh_failed) {
    throw new CognitoReauthRequired("refresh-token rejected by Cognito");
  }
  const accessToken =
    typeof jwt.cognito_access_token === "string"
      ? jwt.cognito_access_token
      : undefined;
  if (!accessToken) {
    throw new CognitoReauthRequired(
      "no Cognito access token on session (dev mode?)",
    );
  }
  return accessToken;
}

/** Non-throwing variant — for UI that wants to render a "Cognito features
 * unavailable" message in dev mode instead of erroring. */
export async function hasCognitoSession(): Promise<boolean> {
  try {
    await getCognitoAccessToken();
    return true;
  } catch {
    return false;
  }
}

/** Read the Cognito refresh token off the encrypted JWT cookie. Used
 * by the sign-out flow to call `RevokeToken` and kill the refresh
 * token immediately, instead of letting it expire naturally (up to
 * 7 days). Returns null in dev mode or when there's no Cognito
 * session — sign-out should still proceed even if revocation can't
 * happen. */
export async function getCognitoRefreshToken(): Promise<string | null> {
  const jwt = await readJwt();
  if (!jwt) return null;
  const refreshToken =
    typeof jwt.cognito_refresh_token === "string"
      ? jwt.cognito_refresh_token
      : undefined;
  return refreshToken ?? null;
}
