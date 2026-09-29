/** awork OAuth 2.1 token endpoint client.
 *
 * Handles both halves of the OAuth flow:
 *   - `refreshAccessToken` — used by every sync run.
 *   - `exchangeAuthorizationCode` — used by the `/auth/awork/callback`
 *     route handler during interactive re-authorization.
 *
 * Plus the URL builder for the authorize-step redirect, which the
 * `/auth/awork/start` handler uses.
 *
 * This module is the ONLY place in the codebase that issues HTTP POST to
 * the awork API, and only ever against the token endpoint. Enforced by
 * `scripts/check-integration-readonly.ts`. The data-path client (`./client.ts`)
 * is GET-only.
 */
import {
  loadAworkClientCredentials,
  loadAworkTokens,
  storeAworkTokens,
  type AworkTokens,
  type AworkClientCredentials,
} from "@/lib/integrations/core/credentials";

const TOKEN_URL = "https://api.awork.com/api/v1/accounts/token";
const AUTHORIZE_URL = "https://api.awork.com/api/v1/accounts/authorize";

/** OAuth scope. awork's default for our integration is read-only on
 * companies, users, projects, and time entries. Override via env if the
 * awork app registration uses a different scope string. */
function aworkOauthScope(): string {
  return process.env.AWORK_OAUTH_SCOPE?.trim() || "offline_access";
}

export class AworkNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AworkNotAuthorizedError";
  }
}

function isTokenValid(t: AworkTokens, leeway_seconds = 30): boolean {
  return Date.now() / 1000 + leeway_seconds < t.expires_at;
}

/** Return a fresh access token, refreshing if needed. */
export async function getValidAccessToken(): Promise<string> {
  const tokens = await loadAworkTokens();
  if (!tokens) {
    throw new AworkNotAuthorizedError(
      "No awork tokens stored. Authorize via the settings page.",
    );
  }
  if (isTokenValid(tokens)) return tokens.access_token;

  const creds = await loadAworkClientCredentials();
  let refreshed: AworkTokens;
  try {
    refreshed = await refreshAccessToken(creds, tokens.refresh_token);
  } catch {
    // Refresh failed — most likely 30-day expiry. Surface cleanly so the
    // operator knows to re-authorize.
    throw new AworkNotAuthorizedError(
      "awork refresh token rejected (likely expired). Re-authorize via the settings page.",
    );
  }
  await storeAworkTokens(refreshed);
  return refreshed.access_token;
}

async function postToTokenEndpoint(
  creds: AworkClientCredentials,
  body: Record<string, string>,
): Promise<AworkTokens> {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (creds.client_secret) {
    // Confidential client → HTTP Basic per RFC 6749 §2.3.1.
    const basic = Buffer.from(
      `${creds.client_id}:${creds.client_secret}`,
    ).toString("base64");
    (headers as Record<string, string>).Authorization = `Basic ${basic}`;
  } else if (!body.client_id) {
    body.client_id = creds.client_id;
  }
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  if (!r.ok) {
    throw new Error(
      `awork token endpoint returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  const data = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(
      `awork token response missing required fields: ${JSON.stringify(Object.keys(data))}`,
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  };
}

async function refreshAccessToken(
  creds: AworkClientCredentials,
  refresh_token: string,
): Promise<AworkTokens> {
  return postToTokenEndpoint(creds, {
    grant_type: "refresh_token",
    refresh_token,
  });
}

/** Build the authorize-step redirect URL. The caller (the
 * `/auth/awork/start` route handler) generates the verifier + state,
 * persists them, then redirects the browser here. */
export async function buildAuthorizeUrl(opts: {
  redirect_uri: string;
  code_challenge: string;
  state: string;
}): Promise<string> {
  const creds = await loadAworkClientCredentials();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.client_id,
    redirect_uri: opts.redirect_uri,
    code_challenge: opts.code_challenge,
    code_challenge_method: "S256",
    state: opts.state,
    scope: aworkOauthScope(),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code (from the OAuth callback) for tokens.
 * The caller is responsible for verifying the `state` round-trip before
 * calling this — that check guards against CSRF and is not the token
 * endpoint's job. */
export async function exchangeAuthorizationCode(opts: {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}): Promise<AworkTokens> {
  const creds = await loadAworkClientCredentials();
  return postToTokenEndpoint(creds, {
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.code_verifier,
    redirect_uri: opts.redirect_uri,
  });
}

/** Read-only summary for the settings UI. Never throws — returns a
 * structured "not configured" state instead, since the page needs to
 * render either way. */
export async function getAworkAuthStatus(): Promise<
  | { state: "missing_client"; reason: string }
  | { state: "no_tokens" }
  | { state: "authorized"; expires_at: number; is_expired: boolean }
> {
  try {
    await loadAworkClientCredentials();
  } catch (err) {
    return {
      state: "missing_client",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const tokens = await loadAworkTokens();
  if (!tokens) return { state: "no_tokens" };
  return {
    state: "authorized",
    expires_at: tokens.expires_at,
    is_expired: !isTokenValid(tokens, 0),
  };
}
