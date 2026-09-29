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
  markCredentialChecked,
  markCredentialSet,
} from "@/lib/db/queries/integration";
import { getAdapter } from "@/lib/integrations/core/registry";
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
