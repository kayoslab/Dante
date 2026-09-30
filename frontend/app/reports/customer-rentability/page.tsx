import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { isoMonthOf, shiftMonth } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";
import {
  buildCustomerRentabilityMonth,
  buildCustomerRentabilitySeries,
} from "@/lib/reports/customer-rentability";

import { CustomerRentabilityClient } from "./customer-rentability-client";

export const metadata = { title: "Customer rentability — Dante" };

export default async function CustomerRentabilityPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_customer_rentability",
    target_type: "report",
    target_id: "customer_rentability",
  });

  // Prefetch the two queries the client fires on mount so the first
  // paint ships populated data. Keys must match
  // `useCustomerRentabilityMonth` / `useCustomerRentabilitySeries` in
  // lib/api/customer-rentability.ts exactly (the series hook is called
  // from components/customer-rentability/customer-rentability-chart.tsx
  // with -12..+3) — keep in sync with those hooks.
  // A server/browser timezone mismatch around midnight on the month
  // boundary just makes the prefetch miss and the client fetch as before
  // — harmless.
  const todayMonth = isoMonthOf(new Date());
  const from = shiftMonth(todayMonth, -12);
  const to = shiftMonth(todayMonth, +3);
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["reports", "customer-rentability", "month", todayMonth],
      queryFn: () => buildCustomerRentabilityMonth(todayMonth),
    }),
    qc.prefetchQuery({
      queryKey: ["reports", "customer-rentability", "series", from, to],
      queryFn: () => buildCustomerRentabilitySeries(from, to),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <CustomerRentabilityClient />
    </HydrationBoundary>
  );
}
