/** Credential access for adapters, on top of the secret store.
 *
 * Adapters never touch the store directly: they ask for the credential
 * document of their integration and get back the fields an admin entered
 * (or, with the env store, the matching `<SLUG>_<FIELD>` variables). The
 * required-field check produces one clear error naming the store, so a
 * missing credential is diagnosable from the sync log alone.
 *
 * OAuth tokens (awork) are a second document, rotated on every sync.
 */
import { getSecretStore, type SecretDocument } from "./secret-store";

export class CredentialsMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsMissingError";
  }
}

/** Load the credential document of `slug` and check that every key in
 *  `required` is a non-empty string. Other keys pass through untouched. */
export async function loadIntegrationCredentials(
  slug: string,
  required: readonly string[],
): Promise<Record<string, string | null>> {
  const store = getSecretStore();
  const doc = await store.get(slug, "credentials");
  if (!doc) {
    throw new CredentialsMissingError(
      `No credentials stored for integration "${slug}" (secret store: ${store.kind}). ` +
        hint(store.kind),
    );
  }
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = v === null || v === undefined || v === "" ? null : String(v);
  }
  const missing = required.filter((k) => !out[k]);
  if (missing.length > 0) {
    throw new CredentialsMissingError(
      `Credentials for integration "${slug}" are missing ${missing.join(", ")} (secret store: ${store.kind}). ` +
        hint(store.kind),
    );
  }
  return out;
}

function hint(kind: string): string {
  switch (kind) {
    case "env":
      return "Set the <SLUG>_<FIELD> variables in .env (e.g. PERSONIO_CLIENT_ID), or enable a writable store and enter them under Settings → Integrations.";
    case "secretsmanager":
      return "Enter them under Settings → Integrations, or seed the secret with scripts/seed-secrets.ts.";
    default:
      return "Enter them under Settings → Integrations.";
  }
}

// --- Personio ----------------------------------------------------------------

export type PersonioCredentials = { client_id: string; client_secret: string };

export async function loadPersonioCredentials(): Promise<PersonioCredentials> {
  const c = await loadIntegrationCredentials("personio", ["client_id", "client_secret"]);
  return { client_id: c.client_id!, client_secret: c.client_secret! };
}

// --- awork -------------------------------------------------------------------

export type AworkClientCredentials = {
  client_id: string;
  client_secret: string | null; // null for public clients (PKCE only)
};

export async function loadAworkClientCredentials(): Promise<AworkClientCredentials> {
  const c = await loadIntegrationCredentials("awork", ["client_id"]);
  return { client_id: c.client_id!, client_secret: c.client_secret ?? null };
}

/** OAuth tokens — refreshed and rewritten on each sync. */
export type OAuthTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
};
export type AworkTokens = OAuthTokens;

function parseTokens(doc: SecretDocument | null): OAuthTokens | null {
  if (!doc) return null;
  const access_token = doc.access_token;
  const refresh_token = doc.refresh_token;
  const expires_at = Number(doc.expires_at);
  if (typeof access_token !== "string" || typeof refresh_token !== "string") return null;
  if (!access_token || !refresh_token || !Number.isFinite(expires_at)) return null;
  return { access_token, refresh_token, expires_at };
}

export async function loadOAuthTokens(slug: string): Promise<OAuthTokens | null> {
  return parseTokens(await getSecretStore().get(slug, "tokens"));
}

export async function storeOAuthTokens(slug: string, t: OAuthTokens): Promise<void> {
  await getSecretStore().put(slug, "tokens", t);
}

export const loadAworkTokens = (): Promise<AworkTokens | null> => loadOAuthTokens("awork");
export const storeAworkTokens = (t: AworkTokens): Promise<void> => storeOAuthTokens("awork", t);

// --- Status for the settings UI ---------------------------------------------

export type OAuthStatus =
  | { state: "missing_client"; reason: string }
  | { state: "no_tokens" }
  | { state: "authorized"; expires_at: number; is_expired: boolean };

/** Read-only summary of an OAuth integration's connection. Never throws —
 *  the settings page needs to render either way. */
export async function oauthStatus(slug: string, requiredClientFields: readonly string[]): Promise<OAuthStatus> {
  try {
    await loadIntegrationCredentials(slug, requiredClientFields);
  } catch (err) {
    return { state: "missing_client", reason: err instanceof Error ? err.message : String(err) };
  }
  const tokens = await loadOAuthTokens(slug);
  if (!tokens) return { state: "no_tokens" };
  return {
    state: "authorized",
    expires_at: tokens.expires_at,
    is_expired: Date.now() / 1000 >= tokens.expires_at,
  };
}
