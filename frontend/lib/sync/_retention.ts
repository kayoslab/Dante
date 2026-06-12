/** Audit log retention.
 *
 * Runs once per sync invocation. Deletes rows older than the configured
 * window (default 30 days — keeps the table small and meets GDPR's
 * data-minimization stance for security audit trails on a 40-person
 * workforce: month-long visibility is plenty for incident response and
 * "who saw what last week" questions, while reducing the retained
 * surface area).
 *
 * Override via env: `DANTE_AUDIT_RETENTION_DAYS=30`.
 *
 * Non-fatal: a purge failure logs and continues. The next sync will try
 * again. Better to skip housekeeping than to fail the whole sync.
 */
import { lt } from "drizzle-orm";
import type { Client } from "pg";

import { appAuditLog } from "@/lib/db/schema";
import { syncDrizzle } from "./db";

const DEFAULT_RETENTION_DAYS = 30;

function retentionDays(): number {
  const raw = process.env.DANTE_AUDIT_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export type AuditRetentionResult = {
  deleted: number;
  cutoff: Date;
  retention_days: number;
};

export async function purgeAuditLog(
  conn: Client,
): Promise<AuditRetentionResult> {
  const db = syncDrizzle(conn);
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 86_400_000);
  // Drizzle's delete with `.returning()` gives us the count without a
  // separate SELECT round-trip.
  const deleted = await db
    .delete(appAuditLog)
    .where(lt(appAuditLog.occurred_at, cutoff))
    .returning({ audit_id: appAuditLog.audit_id });
  return {
    deleted: deleted.length,
    cutoff,
    retention_days: days,
  };
}
