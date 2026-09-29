/** Read / write the integration model for the settings UI: `integration`
 * rows, `integration_binding` (which integration feeds which capability,
 * in priority order) and `integration_rule` (per-capability policies).
 * The secret documents never pass through here — see
 * lib/integrations/core/secret-store.ts. */
import { asc, eq } from "drizzle-orm";

import { db } from "../client";
import {
  integration,
  integrationBinding,
  integrationRule,
  type CredentialState,
} from "../schema";
import type { Capability } from "@/lib/integrations/core/capabilities";

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

export async function insertIntegration(input: {
  slug: string;
  provider: string;
  display_name: string;
}): Promise<IntegrationRow> {
  const now = new Date();
  const [row] = await db
    .insert(integration)
    .values({
      slug: input.slug,
      provider: input.provider,
      display_name: input.display_name,
      enabled: false,
      config: {},
      credential_state: "missing",
      created_at: now,
      updated_at: now,
    })
    .returning(columns);
  return row;
}

export async function updateIntegration(
  slug: string,
  patch: { display_name?: string; config?: Record<string, unknown>; enabled?: boolean },
): Promise<IntegrationRow | null> {
  const [row] = await db
    .update(integration)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(integration.slug, slug))
    .returning(columns);
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

// --- bindings ----------------------------------------------------------------

export type BindingRow = {
  capability: Capability;
  integration_slug: string;
  priority: number;
  enabled: boolean;
};

export async function listBindings(): Promise<BindingRow[]> {
  return await db
    .select({
      capability: integrationBinding.capability,
      integration_slug: integrationBinding.integration_slug,
      priority: integrationBinding.priority,
      enabled: integrationBinding.enabled,
    })
    .from(integrationBinding)
    .orderBy(asc(integrationBinding.capability), asc(integrationBinding.priority));
}

/** Replace one capability's bindings with `slugs` in priority order
 * (index 0 = primary). One transaction: the (capability, priority)
 * uniqueness makes an in-place renumbering awkward, and a delete +
 * reinsert is exactly what "this is the new order" means. */
export async function replaceBindings(capability: Capability, slugs: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(integrationBinding).where(eq(integrationBinding.capability, capability));
    if (slugs.length === 0) return;
    await tx.insert(integrationBinding).values(
      slugs.map((integration_slug, priority) => ({
        capability,
        integration_slug,
        priority,
        enabled: true,
      })),
    );
  });
}

// --- rules -------------------------------------------------------------------

export type RuleRow = { capability: Capability; key: string; value: Record<string, unknown> };

export async function listRules(): Promise<RuleRow[]> {
  return await db
    .select({
      capability: integrationRule.capability,
      key: integrationRule.key,
      value: integrationRule.value,
    })
    .from(integrationRule)
    .orderBy(asc(integrationRule.capability), asc(integrationRule.key));
}

export async function upsertRule(
  capability: Capability,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(integrationRule)
    .values({ capability, key, value, updated_at: new Date() })
    .onConflictDoUpdate({
      target: [integrationRule.capability, integrationRule.key],
      set: { value, updated_at: new Date() },
    });
}
