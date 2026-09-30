import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { isoMonthOf, shiftMonth } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";
import {
  buildUtilizationMonth,
  buildUtilizationSeries,
} from "@/lib/reports/utilization";

import { UtilizationClient } from "./utilization-client";

export const metadata = { title: "Utilization — Dante" };

export default async function UtilizationPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_utilization",
    target_type: "report",
    target_id: "utilization",
  });

  // Prefetch the two queries the client shell fires on mount so the
  // first paint ships populated data. Keys must match
  // `useUtilizationSeries` / `useUtilizationMonth` in lib/api/utilization.ts
  // exactly — keep in sync with those hooks.
  // A server/browser timezone mismatch around midnight on the month
  // boundary just makes the prefetch miss and the client fetch as before
  // — harmless.
  const todayMonth = isoMonthOf(new Date());
  const from = shiftMonth(todayMonth, -12);
  const to = shiftMonth(todayMonth, +3);
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["reports", "utilization", "series", from, to],
      queryFn: () => buildUtilizationSeries(from, to),
    }),
    qc.prefetchQuery({
      queryKey: ["reports", "utilization", "month", todayMonth],
      queryFn: () => buildUtilizationMonth(todayMonth),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <UtilizationClient />
    </HydrationBoundary>
  );
}
