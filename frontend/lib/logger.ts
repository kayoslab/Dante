/** Minimal structured logger.
 *
 * Outputs one JSON object per line — the shape CloudWatch Logs Insights
 * and most aggregators can index directly. Plain `console.error("msg",
 * obj)` breaks into multiple log records and loses the contextual
 * fields, which is what motivates this helper.
 *
 * Levels: debug | info | warn | error. Anything ≥ DANTE_LOG_LEVEL is
 * emitted. Default `info` in prod, `debug` everywhere else.
 *
 * Usage:
 *   import { log } from "@/lib/logger";
 *   log.error("portfolio_monthly_failed", { route: "/api/portfolio/monthly", err });
 *
 * The first arg is the event slug — keep it terse and snake_case so it's
 * groupable in logs. Put variable detail in the fields object.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function configuredLevel(): Level {
  const raw = process.env.DANTE_LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) return raw as Level;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { value: String(err) };
}

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      // Auto-unwrap Error values — common enough to be worth the special case.
      record[k] = v instanceof Error ? serializeError(v) : v;
    }
  }
  // stderr → CloudWatch picks it up the same as stdout but keeps error
  // logs out of stdout streams used for sync output.
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(record) + "\n");
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
