import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { computeFpBurndownForMonth } from "@/lib/db/queries/fp-burndown";
import { isoMonthOf } from "@/lib/month";
import { getQueryClient } from "@/lib/query/server";

import { FpBurndownClient } from "./fp-burndown-client";

export const metadata = { title: "Fixed-price burn-down — Dante" };

export default async function FpBurndownPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_fp_burndown",
    target_type: "report",
    target_id: "fp_burndown",
  });

  // Prefetch the month the client selects on first render
  // (`isoMonthOf(new Date())` in fp-burndown-client.tsx). Key must match
  // `useFpBurndownMonth` in lib/api/fp-burndown.ts exactly; the payload is
  // what app/api/reports/fp-burndown/month/route.ts returns.
  // A server/browser timezone mismatch around midnight on the month
  // boundary only makes this prefetch miss — the client then fetches as
  // before. Harmless.
  const qc = getQueryClient();
  const month = isoMonthOf(new Date());
  const today = new Date().toISOString().slice(0, 10);
  await qc.prefetchQuery({
    queryKey: ["reports", "fp-burndown", "month", month],
    queryFn: () => computeFpBurndownForMonth(month, today),
  });

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <FpBurndownClient />
    </HydrationBoundary>
  );
}
