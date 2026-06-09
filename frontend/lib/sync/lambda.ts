/** Lambda handler shape for the scheduled sync.
 *
 * EventBridge fires a scheduled rule that invokes this handler with an
 * optional event payload to scope what runs. The runtime config matches
 * what the local CLI uses, so behaviour parity is structural — same
 * `runSync()` call, same `SyncOptions` schema, same connection setup.
 *
 * The handler is intentionally thin. Anything non-trivial belongs in
 * `run.ts` so the CLI can exercise the same code path.
 *
 * Logging: each sync line goes to CloudWatch via the structured `logger`
 * as it's emitted (one JSON record per line, `event: "sync_line"`). The
 * response carries only summary counters — never the full log array, so
 * the response stays small even for runs with thousands of records.
 */
import type { Context } from "aws-lambda";

import { log as logger } from "@/lib/logger";

import { runSync, type SyncOptions } from "./run";

/** Event payload. EventBridge schedulers pass a static JSON object you
 * define at rule-creation time, so the shape is whatever you wire up.
 * Empty object → defaults (all sources, all subsyncs). */
export type SyncEvent = Partial<SyncOptions> & {
  /** Forces `DANTE_USE_SECRETS_MANAGER=1` for this invocation. Useful
   * when re-running an old container with a partial env. */
  use_secrets_manager?: boolean;
};

export type SyncResult = {
  ok: boolean;
  duration_ms: number;
  source: SyncOptions["source"];
  /** Number of log lines emitted to CloudWatch during the run. The
   * lines themselves are not returned — query CloudWatch Logs Insights
   * by `request_id` to retrieve them. */
  log_lines: number;
  error?: { name: string; message: string };
};

export async function handler(
  event: SyncEvent = {},
  context?: Context,
): Promise<SyncResult> {
  const started_at = Date.now();
  if (event.use_secrets_manager) {
    process.env.DANTE_USE_SECRETS_MANAGER = "1";
  }

  const request_id = context?.awsRequestId;
  let log_lines = 0;
  const opts: SyncOptions = {
    source: event.source,
    absence_days: event.absence_days,
    attendance_days: event.attendance_days,
    time_entry_days: event.time_entry_days,
    skip_absences: event.skip_absences,
    skip_attendances: event.skip_attendances,
    skip_compensations: event.skip_compensations,
    skip_time_entries: event.skip_time_entries,
    skip_awork_maintenance: event.skip_awork_maintenance,
  };

  logger.info("sync_start", { request_id, source: opts.source ?? "all" });

  try {
    await runSync(opts, (line) => {
      log_lines += 1;
      // Per-line logs at debug level — CloudWatch only ingests them
      // when DANTE_LOG_LEVEL=debug. Default prod level is info, so the
      // sync produces ~3 CloudWatch events per run (start, complete,
      // any error), not thousands. Was M-010 in the pre-launch pen
      // test (CloudWatch cost amplification at scale).
      logger.debug("sync_line", { request_id, line });
    });
    const duration_ms = Date.now() - started_at;
    logger.info("sync_complete", { request_id, duration_ms, log_lines });
    return {
      ok: true,
      duration_ms,
      source: opts.source ?? "all",
      log_lines,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    const duration_ms = Date.now() - started_at;
    logger.error("sync_failed", { request_id, duration_ms, name, message });
    return {
      ok: false,
      duration_ms,
      source: opts.source ?? "all",
      log_lines,
      error: { name, message },
    };
  }
}
