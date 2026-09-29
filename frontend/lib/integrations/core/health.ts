/** "Test connection" for one integration.
 *
 * Builds the adapter's client from the stored credentials and runs its
 * `healthCheck`. Runs wherever the credentials are readable: in-process
 * in dev, inside the sync Lambda in prod (the web app's task role cannot
 * read static credentials there — see the settings action, which
 * dispatches by `DANTE_SYNC_LAMBDA_NAME`).
 */
import { openSyncConn } from "@/lib/sync/db";

import { loadIntegrationConfig } from "./config";
import { getAdapter } from "./registry";
import type { HealthStatus } from "./types";

export type HealthCheckResult = HealthStatus & { integration: string; duration_ms: number };

export async function runHealthCheck(slug: string): Promise<HealthCheckResult> {
  const started = Date.now();
  const fail = (detail: string): HealthCheckResult => ({
    ok: false,
    detail,
    integration: slug,
    duration_ms: Date.now() - started,
  });

  const conn = await openSyncConn();
  let integration;
  try {
    const cfg = await loadIntegrationConfig(conn);
    integration = cfg.integrations.get(slug);
  } finally {
    await conn.end();
  }
  if (!integration) return fail(`integration "${slug}" is not configured`);
  const adapter = getAdapter(integration.provider);
  if (!adapter) return fail(`provider "${integration.provider}" is not registered`);

  try {
    const config = adapter.configSchema.parse(integration.config);
    const client = await adapter.createClient({ integration, config, log: () => {} });
    const status = await adapter.healthCheck(client);
    return { ...status, integration: slug, duration_ms: Date.now() - started };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
