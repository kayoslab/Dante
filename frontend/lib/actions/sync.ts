"use server";

/** /settings → "Sync" button.
 *
 * Was an in-process call to `runSync()` reading Personio + awork creds
 * from Secrets Manager directly in the web-app task. That required the
 * task role to hold `secretsmanager:GetSecretValue` on the Personio
 * client + the awork OAuth tokens — and any app-level RCE then got a
 * one-shot to exfiltrate or overwrite those credentials.
 *
 * Now we invoke the existing sync Lambda (which already runs the
 * daily cron) synchronously. The Lambda has its own narrowly-scoped
 * IAM role; the web app only needs `lambda:InvokeFunction` on this
 * specific function ARN. Net effect: app-RCE escalation path closes,
 * the sync uses the same code path the cron uses (no drift), and the
 * UI gets the same blocking behaviour it had before.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  InvokeCommand,
  LambdaClient,
  type InvokeCommandOutput,
} from "@aws-sdk/client-lambda";

import { audit } from "@/lib/auth/audit";
import { ForbiddenError, requireSession } from "@/lib/auth/session";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";

const RunSyncSchema = z.object({
  source: z.enum(["all", "personio", "awork"]),
});

export type RunSyncSuccess = {
  source: "all" | "personio" | "awork";
  duration_ms: number;
  log: string;
};

let lambdaClient: LambdaClient | null = null;
function lambda(): LambdaClient {
  if (lambdaClient) return lambdaClient;
  const region =
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error("AWS_REGION is not set; cannot construct LambdaClient.");
  }
  // 8-minute call cap — covers the 5-minute Lambda timeout plus a margin
  // for cold start. Inactivity timeouts on the underlying HTTPS socket
  // would otherwise close the connection during a long sync.
  lambdaClient = new LambdaClient({
    region,
    requestHandler: { requestTimeout: 480_000, connectionTimeout: 10_000 },
  });
  return lambdaClient;
}

export async function runSyncAction(
  input: unknown,
): Promise<ActionResult<RunSyncSuccess>> {
  let ctx;
  try {
    ctx = await requireSession({ minRole: "admin" });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return err("forbidden", "Only admins can trigger a sync.");
    }
    throw e;
  }
  const parsed = RunSyncSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  await audit(ctx, {
    action: "sync_triggered",
    target_type: "sync",
    target_id: parsed.data.source,
  });

  const functionName = process.env.DANTE_SYNC_LAMBDA_NAME;
  if (!functionName) {
    return err(
      "internal_error",
      "DANTE_SYNC_LAMBDA_NAME is not set on the task. Wire it via the ECS task definition (terraform/envs/prod/main.tf).",
    );
  }

  const started = Date.now();
  let result: InvokeCommandOutput;
  try {
    result = await lambda().send(
      new InvokeCommand({
        FunctionName: functionName,
        // RequestResponse = synchronous; we wait for the Lambda to
        // complete and surface its output to the admin. The daily cron
        // uses Event (async) because no operator is watching.
        InvocationType: "RequestResponse",
        // Pass `use_secrets_manager` so the Lambda hits the same env
        // shape the daily cron uses.
        Payload: new TextEncoder().encode(
          JSON.stringify({
            source: parsed.data.source,
            use_secrets_manager: true,
          }),
        ),
      }),
    );
  } catch (e) {
    return err(
      "internal_error",
      `Lambda invoke failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const duration_ms = Date.now() - started;

  // FunctionError is set when the Lambda threw — the payload is the
  // structured error returned by the runtime. Surface it the same shape
  // the in-process sync used to (message + log).
  if (result.FunctionError) {
    const payload = result.Payload
      ? new TextDecoder().decode(result.Payload)
      : "";
    return err(
      "internal_error",
      `Sync Lambda raised ${result.FunctionError}: ${payload}`,
    );
  }

  // Sync wrote to many tables; tell Next.js to drop its cached server renders
  // so dashboards reflect fresh data on next navigation.
  revalidatePath("/", "layout");

  // The Lambda response shape is `{ duration_ms, source, log_lines }`
  // (see frontend/lib/sync/lambda.ts). We don't surface the per-line
  // log from CloudWatch here — admins can pull it from CloudWatch
  // Logs Insights by request_id if they need to debug a failure.
  return ok({
    source: parsed.data.source,
    duration_ms,
    log: result.Payload
      ? new TextDecoder().decode(result.Payload)
      : "(empty response)",
  });
}
