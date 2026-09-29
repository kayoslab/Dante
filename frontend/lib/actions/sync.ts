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

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

const RunSyncSchema = z.object({
  /** "all" or the slug of a configured integration (the runner ignores
   *  anything that isn't enabled). */
  source: z.union([z.literal("all"), z.string().regex(/^[a-z][a-z0-9_-]*$/)]),
});

export type RunSyncSuccess = {
  source: string;
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
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;
  const parsed = RunSyncSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  await audit(ctx, {
    action: "sync_triggered",
    target_type: "sync",
    target_id: parsed.data.source,
  });

  const functionName = process.env.DANTE_SYNC_LAMBDA_NAME;
  // Local-dev fallback: when there's no Lambda wired (i.e. running
  // `npm run dev` with no AWS plumbing), run the sync in-process via
  // the same `runSync()` the Lambda uses. The Secrets-Manager
  // isolation argument doesn't apply outside prod, and the alternative
  // is "no sync button in dev" which makes integration changes
  // painful to verify.
  if (!functionName) {
    const { runSync } = await import("@/lib/sync/run");
    const lines: string[] = [];
    const started = Date.now();
    try {
      // Manual sync forces a full scan on both integrations — an admin
      // clicking "Sync" expects a guaranteed complete refresh, and it's
      // the reconciliation safety net for the scheduled delta pulls.
      await runSync(
        { source: parsed.data.source, awork_full: true, attendance_full: true },
        (line) => lines.push(line),
      );
    } catch (e) {
      return err(
        "internal_error",
        `${e instanceof Error ? e.message : String(e)}\n\n${lines.join("\n")}`,
      );
    }
    return ok({
      source: parsed.data.source,
      duration_ms: Date.now() - started,
      log: lines.join("\n"),
    });
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
        // `*_full: true` — a manual sync guarantees a complete refresh of
        // both integrations (the scheduled cron uses the delta pulls).
        Payload: new TextEncoder().encode(
          JSON.stringify({
            source: parsed.data.source,
            use_secrets_manager: true,
            awork_full: true,
            attendance_full: true,
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
