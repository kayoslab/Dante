import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { isoMonthOf, shiftMonth } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";
import {
  buildPortfolioRentabilityMonth,
  buildPortfolioRentabilitySeries,
} from "@/lib/reports/portfolio-rentability";

import { PortfolioRentabilityClient } from "./portfolio-rentability-client";

export const metadata = { title: "Portfolio rentability — Dante" };

export default async function PortfolioRentabilityPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_portfolio_rentability",
    target_type: "report",
    target_id: "portfolio_rentability",
  });

  // Prefetch the two queries the client shell fires on mount so the
  // first paint ships populated data. Keys must match `usePortfolioMonthly`
  // (lib/api/portfolio.ts) and `usePortfolioRentabilitySeries`
  // (lib/api/portfolio-rentability-series.ts) exactly — keep in sync
  // with those hooks.
  // A server/browser timezone mismatch around midnight on the month
  // boundary just makes the prefetch miss and the client fetch as before
  // — harmless.
  const todayMonth = isoMonthOf(new Date());
  const from = shiftMonth(todayMonth, -12);
  const to = shiftMonth(todayMonth, +3);
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["reports", "portfolio-rentability", "month", todayMonth],
      queryFn: () => buildPortfolioRentabilityMonth(todayMonth),
    }),
    qc.prefetchQuery({
      queryKey: ["reports", "portfolio-rentability", "series", from, to],
      queryFn: () => buildPortfolioRentabilitySeries(from, to),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <PortfolioRentabilityClient />
    </HydrationBoundary>
  );
}
