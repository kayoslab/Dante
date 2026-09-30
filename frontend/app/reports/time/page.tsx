import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { employeeKeys } from "@/lib/api/keys";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { listEmployeeTeams } from "@/lib/db/queries/employee-list";
import { isoMonthOf } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";
import { buildTrackedHoursMonth } from "@/lib/reports/tracked-hours";

import { TimeClient } from "./time-client";

export const metadata = { title: "Tracked hours — Dante" };

export default async function TrackedHoursReportPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_report_tracked_hours",
    target_type: "report",
    target_id: "tracked-hours",
  });

  // Prefetch what `TimeClient` asks for on its first render so the first
  // paint ships populated KPIs + rows instead of a skeleton:
  //  - `useEmployeeTeams()`            → employeeKeys.teams()
  //  - `useTrackedHours(month, undefined)` → ["tracked-hours", month, null]
  // Keys must match the hooks in lib/api/employees.ts + lib/api/tracked-hours.ts
  // exactly (keep in sync). A server/browser timezone mismatch around
  // midnight on the month boundary just makes the prefetch miss and the
  // client fetch as before — harmless.
  const month = isoMonthOf(new Date());
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: employeeKeys.teams(),
      queryFn: () => listEmployeeTeams(),
    }),
    qc.prefetchQuery({
      queryKey: ["tracked-hours", month, null],
      queryFn: () => buildTrackedHoursMonth({ month, team: null }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <TimeClient />
    </HydrationBoundary>
  );
}
