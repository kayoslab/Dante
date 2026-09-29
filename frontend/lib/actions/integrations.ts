"use server";

/** Settings → Integrations: store credentials (write-only) and test the
 * connection.
 *
 * Credentials go straight into the secret store and are never returned
 * to the browser — the UI only ever learns `credential_state`,
 * `credential_set_at` and `credential_set_by` from the integration row.
 *
 * The connection test needs to *read* the credentials, which the web
 * app's task role is deliberately not allowed to do in prod. So, like
 * the Sync button, it dispatches to the sync Lambda when
 * `DANTE_SYNC_LAMBDA_NAME` is set and runs in-process otherwise (dev).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import { audit } from "@/lib/auth/audit";
import {
  getIntegration,
  insertIntegration,
  listIntegrations,
  markCredentialChecked,
  markCredentialSet,
  replaceBindings,
  updateIntegration,
  upsertRule,
} from "@/lib/db/queries/integration";
import { isCapability, type Capability } from "@/lib/integrations/core/capabilities";
import { coerceConfigValues, describeConfigSchema } from "@/lib/integrations/core/config-form";
import { getAdapter, PROVIDERS } from "@/lib/integrations/core/registry";
import { ruleDefinition } from "@/lib/integrations/core/rules";
import { getSecretStore, SecretStoreReadOnlyError } from "@/lib/integrations/core/secret-store";
import type { HealthCheckResult } from "@/lib/integrations/core/health";

import { err, fromZod, ok, requireActionRole, type ActionResult } from "./_action-helpers";

const SlugSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const CredentialValuesSchema = z.record(z.string(), z.string());

export type SaveCredentialsSuccess = { slug: string; credential_set_at: string };

export async function saveIntegrationCredentialsAction(
  slugInput: unknown,
  valuesInput: unknown,
): Promise<ActionResult<SaveCredentialsSuccess>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const slugParsed = SlugSchema.safeParse(slugInput);
  if (!slugParsed.success) return fromZod(slugParsed.error);
  const valuesParsed = CredentialValuesSchema.safeParse(valuesInput);
  if (!valuesParsed.success) return fromZod(valuesParsed.error);
  const slug = slugParsed.data;

  const row = await getIntegration(slug);
  if (!row) return err("not_found", `integration "${slug}" is not configured`);
  const adapter = getAdapter(row.provider);
  if (!adapter) return err("not_found", `provider "${row.provider}" is not registered`);

  // Only the fields the adapter declares, every required one non-empty.
  const doc: Record<string, string | null> = {};
  for (const field of adapter.auth.fields) {
    const v = valuesParsed.data[field.key]?.trim() ?? "";
    if (!v && field.required) {
      return err("validation_error", `${field.label} is required`);
    }
    doc[field.key] = v || null;
  }
  const unknown = Object.keys(valuesParsed.data).filter(
    (k) => !adapter.auth.fields.some((f) => f.key === k),
  );
  if (unknown.length > 0) {
    return err("validation_error", `unknown credential field(s): ${unknown.join(", ")}`);
  }

  const store = getSecretStore();
  try {
    await store.put(slug, "credentials", doc);
  } catch (e) {
    if (e instanceof SecretStoreReadOnlyError) return err("forbidden", e.message);
    await audit(ctx, {
      action: "integration_credential_set_failed",
      target_type: "integration",
      target_id: slug,
    });
    return err("internal_error", `could not store credentials: ${e instanceof Error ? e.message : String(e)}`);
  }

  await markCredentialSet(slug, ctx.email);
  await audit(ctx, {
    action: "integration_credential_set",
    target_type: "integration",
    target_id: slug,
  });
  revalidatePath("/settings/integrations");
  revalidatePath(`/settings/integrations/${slug}`);
  return ok({ slug, credential_set_at: new Date().toISOString() });
}

export type TestConnectionSuccess = HealthCheckResult;

export async function testIntegrationConnectionAction(
  slugInput: unknown,
): Promise<ActionResult<TestConnectionSuccess>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const slugParsed = SlugSchema.safeParse(slugInput);
  if (!slugParsed.success) return fromZod(slugParsed.error);
  const slug = slugParsed.data;

  const row = await getIntegration(slug);
  if (!row) return err("not_found", `integration "${slug}" is not configured`);

  let result: HealthCheckResult;
  const functionName = process.env.DANTE_SYNC_LAMBDA_NAME;
  if (!functionName) {
    const { runHealthCheck } = await import("@/lib/integrations/core/health");
    result = await runHealthCheck(slug);
  } else {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) return err("internal_error", "AWS_REGION is not set; cannot invoke the sync Lambda.");
    const lambda = new LambdaClient({
      region,
      requestHandler: { requestTimeout: 60_000, connectionTimeout: 10_000 },
    });
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ mode: "health_check", integration: slug })),
      }),
    );
    const body = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
    if (res.FunctionError) {
      return err("internal_error", `health check failed in the sync Lambda: ${body.slice(0, 300)}`);
    }
    result = JSON.parse(body) as HealthCheckResult;
  }

  await markCredentialChecked(slug, result.ok);
  await audit(ctx, {
    action: "integration_health_check",
    target_type: "integration",
    target_id: slug,
  });
  revalidatePath(`/settings/integrations/${slug}`);
  return ok(result);
}

// ---------------------------------------------------------------------------
// Phase 4: enable / settings / add / bindings / rules
// ---------------------------------------------------------------------------

function revalidateIntegrations(slug?: string): void {
  revalidatePath("/settings/integrations");
  revalidatePath("/settings/integrations/bindings");
  revalidatePath("/settings/sync");
  if (slug) revalidatePath(`/settings/integrations/${slug}`);
}

export async function setIntegrationEnabledAction(
  slugInput: unknown,
  enabledInput: unknown,
): Promise<ActionResult<{ slug: string; enabled: boolean }>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const parsed = z.object({ slug: SlugSchema, enabled: z.boolean() }).safeParse({
    slug: slugInput,
    enabled: enabledInput,
  });
  if (!parsed.success) return fromZod(parsed.error);
  const { slug, enabled } = parsed.data;

  const row = await updateIntegration(slug, { enabled });
  if (!row) return err("not_found", `integration "${slug}" is not configured`);
  await audit(auth.ctx, {
    action: enabled ? "integration_enabled" : "integration_disabled",
    target_type: "integration",
    target_id: slug,
  });
  revalidateIntegrations(slug);
  return ok({ slug, enabled: row.enabled });
}

const IntegrationSettingsSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  /** Raw form values, keyed by config field; coerced per the adapter's
   *  schema before validation. */
  config: z.record(z.string(), z.string()),
});

export async function updateIntegrationSettingsAction(
  slugInput: unknown,
  input: unknown,
): Promise<ActionResult<{ slug: string }>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const slugParsed = SlugSchema.safeParse(slugInput);
  if (!slugParsed.success) return fromZod(slugParsed.error);
  const parsed = IntegrationSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const slug = slugParsed.data;

  const row = await getIntegration(slug);
  if (!row) return err("not_found", `integration "${slug}" is not configured`);
  const adapter = getAdapter(row.provider);
  if (!adapter) return err("not_found", `provider "${row.provider}" is not registered`);

  const fields = describeConfigSchema(adapter.configSchema);
  const coerced = coerceConfigValues(fields, parsed.data.config);
  const validated = adapter.configSchema.safeParse(coerced);
  if (!validated.success) return fromZod(validated.error);

  await updateIntegration(slug, {
    display_name: parsed.data.display_name,
    config: validated.data as Record<string, unknown>,
  });
  await audit(auth.ctx, { action: "integration_updated", target_type: "integration", target_id: slug });
  revalidateIntegrations(slug);
  return ok({ slug });
}

const AddIntegrationSchema = z.object({
  provider: z.string(),
  slug: SlugSchema.max(40),
  display_name: z.string().trim().min(1).max(120),
});

export async function addIntegrationAction(
  input: unknown,
): Promise<ActionResult<{ slug: string }>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const parsed = AddIntegrationSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { provider, slug, display_name } = parsed.data;

  if (!PROVIDERS.some((p) => p.slug === provider)) {
    return err("validation_error", `provider "${provider}" is not registered`);
  }
  if (await getIntegration(slug)) {
    return err("conflict", `an integration with slug "${slug}" already exists`);
  }
  await insertIntegration({ slug, provider, display_name });
  await audit(auth.ctx, { action: "integration_added", target_type: "integration", target_id: slug });
  revalidateIntegrations(slug);
  return ok({ slug });
}

/** Replace one capability's bindings: `slugs` in priority order. Every slug
 *  must be a configured integration whose adapter declares the capability. */
export async function setBindingsAction(
  capabilityInput: unknown,
  slugsInput: unknown,
): Promise<ActionResult<{ capability: Capability; slugs: string[] }>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const parsed = z
    .object({ capability: z.string(), slugs: z.array(SlugSchema).max(20) })
    .safeParse({ capability: capabilityInput, slugs: slugsInput });
  if (!parsed.success) return fromZod(parsed.error);
  const { capability, slugs } = parsed.data;
  if (!isCapability(capability)) return err("validation_error", `unknown capability "${capability}"`);
  if (new Set(slugs).size !== slugs.length) return err("validation_error", "an integration can be bound once per capability");

  const rows = await listIntegrations();
  for (const slug of slugs) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) return err("validation_error", `integration "${slug}" is not configured`);
    const adapter = getAdapter(row.provider);
    if (!adapter?.capabilities.includes(capability)) {
      return err("validation_error", `${row.display_name} does not provide ${capability}`);
    }
  }

  await replaceBindings(capability, slugs);
  await audit(auth.ctx, { action: "binding_changed", target_type: "capability", target_id: capability });
  revalidateIntegrations();
  return ok({ capability, slugs });
}

export async function setRuleAction(
  capabilityInput: unknown,
  keyInput: unknown,
  valueInput: unknown,
): Promise<ActionResult<{ capability: Capability; key: string }>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const parsed = z
    .object({ capability: z.string(), key: z.string().regex(/^[a-z_]+$/) })
    .safeParse({ capability: capabilityInput, key: keyInput });
  if (!parsed.success) return fromZod(parsed.error);
  const { capability, key } = parsed.data;
  if (!isCapability(capability)) return err("validation_error", `unknown capability "${capability}"`);
  const def = ruleDefinition(capability, key);
  if (!def) return err("validation_error", `unknown rule ${capability}.${key}`);
  const value = def.schema.safeParse(valueInput);
  if (!value.success) return fromZod(value.error);

  // Integration references inside the value must point at configured rows.
  const rows = await listIntegrations();
  const known = new Set(rows.map((r) => r.slug));
  const v = value.data as Record<string, unknown>;
  const refs: string[] = [];
  if (typeof v.integration === "string") refs.push(v.integration);
  if (Array.isArray(v.integrations)) refs.push(...(v.integrations as string[]));
  const bad = refs.filter((r) => !known.has(r));
  if (bad.length > 0) return err("validation_error", `unknown integration(s): ${bad.join(", ")}`);

  await upsertRule(capability, key, v);
  await audit(auth.ctx, { action: "rule_changed", target_type: "capability", target_id: `${capability}.${key}` });
  revalidateIntegrations();
  return ok({ capability, key });
}
