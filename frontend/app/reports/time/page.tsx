import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { TimeClient } from "./time-client";

export const metadata = { title: "Tracked hours — Dante" };

// Live tracked-time data; never cache.
export const dynamic = "force-dynamic";

export default async function TrackedHoursReportPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_report_tracked_hours",
    target_type: "report",
    target_id: "tracked-hours",
  });

  return <TimeClient />;
}
