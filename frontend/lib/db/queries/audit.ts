/** Read-side queries for the `/settings/audit` page. The audit log is
 * append-only (writes live in `lib/auth/audit.ts`); these helpers serve
 * the admin viewer with cursor-style pagination. */
import { desc, eq, lt } from "drizzle-orm";

import { db } from "../client";
import { appAuditLog, appUser } from "../schema";

export type AuditLogRow = {
  audit_id: number;
  action: string;
  target_type: string;
  target_id: string | null;
  occurred_at: Date;
  ip_address: string | null;
  actor_email: string | null;
  actor_role: "admin" | "manager" | "employee" | null;
};

/** Read one page of audit rows with the actor's email + role joined in.
 *
 * Cursor-style pagination — show `limit`, keep the (N+1)-th as a
 * sentinel for "more available." `occurred_at` is monotonic-enough for
 * this purpose since the table is append-only. Pass `cursor=null` for
 * the first page; subsequent pages pass the oldest visible
 * `occurred_at`. Returns up to `limit + 1` rows so the caller can
 * detect truncation. */
export async function listAuditLog(args: {
  cursor: Date | null;
  limit: number;
}): Promise<AuditLogRow[]> {
  return await db
    .select({
      audit_id: appAuditLog.audit_id,
      action: appAuditLog.action,
      target_type: appAuditLog.target_type,
      target_id: appAuditLog.target_id,
      occurred_at: appAuditLog.occurred_at,
      ip_address: appAuditLog.ip_address,
      actor_email: appUser.email,
      actor_role: appUser.role,
    })
    .from(appAuditLog)
    .leftJoin(appUser, eq(appUser.user_id, appAuditLog.user_id))
    .where(args.cursor ? lt(appAuditLog.occurred_at, args.cursor) : undefined)
    .orderBy(desc(appAuditLog.occurred_at))
    .limit(args.limit + 1);
}
