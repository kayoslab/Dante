import Link from "next/link";
import { forbidden } from "next/navigation";

import { listAuditLog } from "@/lib/db/queries/audit";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { AuditTable } from "./audit-table";

export const metadata = { title: "Audit log — Dante" };

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  await audit(ctx, { action: "view_audit_log", target_type: "audit_log" });

  const { before } = await searchParams;
  const beforeDate = before ? new Date(before) : null;
  // Reject malformed cursors silently — fall back to first page rather
  // than 500-ing on a hand-edited URL.
  const cursor =
    beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : null;

  // Cursor-style pagination — show PAGE_SIZE, keep the (N+1)-th as a
  // sentinel for "more available." occurred_at is monotonic-enough for
  // this purpose since the table is append-only.
  const rows = await listAuditLog({ cursor, limit: PAGE_SIZE });

  const truncated = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const oldestDate = visible[visible.length - 1]?.occurred_at;
  const olderHref = truncated && oldestDate
    ? `/settings/audit?before=${encodeURIComponent(oldestDate.toISOString())}`
    : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Audit log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Append-only. Showing {visible.length}{" "}
          event{visible.length === 1 ? "" : "s"}
          {cursor && (
            <>
              {" "}
              before {cursor.toISOString().slice(0, 19).replace("T", " ")}
            </>
          )}
          .
        </p>
      </div>

      <AuditTable
        rows={visible.map((r) => ({
          audit_id: r.audit_id,
          action: r.action,
          target_type: r.target_type,
          target_id: r.target_id,
          occurred_at: r.occurred_at.toISOString(),
          ip_address: r.ip_address,
          actor_email: r.actor_email,
          actor_role: r.actor_role,
        }))}
      />

      <div className="flex items-center justify-between text-sm">
        {cursor ? (
          <Link
            href="/settings/audit"
            className="text-muted-foreground hover:underline"
          >
            ← Newest
          </Link>
        ) : (
          <span />
        )}
        {olderHref ? (
          <Link href={olderHref} className="text-muted-foreground hover:underline">
            Older →
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
