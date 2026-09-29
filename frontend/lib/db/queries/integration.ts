/** Read / write the `integration` rows for the settings UI. The secret
 * documents themselves never pass through here — see
 * lib/integrations/core/secret-store.ts. */
import { asc, eq } from "drizzle-orm";

import { db } from "../client";
import { integration, type CredentialState } from "../schema";

export type IntegrationRow = {
  slug: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  credential_state: CredentialState;
  credential_set_at: Date | null;
  credential_set_by: string | null;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_error: string | null;
};

const columns = {
  slug: integration.slug,
  provider: integration.provider,
  display_name: integration.display_name,
  enabled: integration.enabled,
  config: integration.config,
  credential_state: integration.credential_state,
  credential_set_at: integration.credential_set_at,
  credential_set_by: integration.credential_set_by,
  last_sync_at: integration.last_sync_at,
  last_sync_status: integration.last_sync_status,
  last_error: integration.last_error,
};

export async function listIntegrations(): Promise<IntegrationRow[]> {
  return await db.select(columns).from(integration).orderBy(asc(integration.slug));
}

export async function getIntegration(slug: string): Promise<IntegrationRow | null> {
  const [row] = await db.select(columns).from(integration).where(eq(integration.slug, slug));
  return row ?? null;
}

/** Record that an admin stored (or re-stored) credentials through the UI. */
export async function markCredentialSet(slug: string, set_by: string): Promise<void> {
  await db
    .update(integration)
    .set({
      credential_state: "set",
      credential_set_at: new Date(),
      credential_set_by: set_by,
      updated_at: new Date(),
    })
    .where(eq(integration.slug, slug));
}

/** Record the outcome of a connection test. `external` credentials keep
 * their state (Dante doesn't own them); `set` flips to `invalid` on a
 * failure and back on success. */
export async function markCredentialChecked(slug: string, ok: boolean): Promise<void> {
  const [row] = await db
    .select({ credential_state: integration.credential_state })
    .from(integration)
    .where(eq(integration.slug, slug));
  if (!row || row.credential_state === "external" || row.credential_state === "missing") return;
  await db
    .update(integration)
    .set({ credential_state: ok ? "set" : "invalid", updated_at: new Date() })
    .where(eq(integration.slug, slug));
}
