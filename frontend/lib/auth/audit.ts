/** Audit log writer.
 *
 * Append-only — every call inserts one row into `app_audit_log`. No
 * UPDATE, no DELETE. Failures here are intentionally non-fatal: we log
 * to the server console and continue, so a transient DB issue can't
 * break the page render. The audit row is observability, not
 * application-critical data.
 *
 * Where to call this:
 *   - Reads of sensitive data: salary insights, employee detail, audit log
 *   - Mutations from `/settings/*`: role changes, user invites/disables, sync triggers
 *   - Future: data export endpoints, anything that exfiltrates PII
 */
import "server-only";

import { headers } from "next/headers";

import { db } from "@/lib/db/client";
import { appAuditLog } from "@/lib/db/schema";
import { log } from "@/lib/logger";

import type { SessionContext } from "./session";

export type AuditPayload = {
  action: string;
  target_type: string;
  target_id?: string | number | null;
};

export async function audit(
  ctx: SessionContext | null,
  payload: AuditPayload,
): Promise<void> {
  try {
    const h = await headers();
    const ip_address =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      h.get("x-real-ip") ??
      null;
    const user_agent = h.get("user-agent") ?? null;

    await db.insert(appAuditLog).values({
      user_id: ctx?.user_id ?? null,
      action: payload.action,
      target_type: payload.target_type,
      target_id:
        payload.target_id === null || payload.target_id === undefined
          ? null
          : String(payload.target_id),
      ip_address,
      user_agent,
    });
  } catch (err) {
    // Don't crash a page render because the audit write failed. Surface to
    // stderr (CloudWatch in prod) for operator visibility.
    log.error("audit_write_failed", { err, payload });
  }
}
