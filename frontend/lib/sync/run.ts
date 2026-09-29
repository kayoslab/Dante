/** Compatibility entry point for the sync.
 *
 * The orchestration lives in `lib/integrations/core/runner.ts` since the
 * adapter refactor (docs/integration-adapters.md). This module keeps the
 * import path the CLI (`scripts/sync.ts`), the Lambda handler
 * (`./lambda.ts`) and the settings action use.
 */
export { runSync, type SyncLogger, type SyncOptions } from "@/lib/integrations/core/runner";
