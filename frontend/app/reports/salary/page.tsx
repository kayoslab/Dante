import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { hasRole, requireSession } from "@/lib/auth/session";
import { audit } from "@/lib/auth/audit";
import { getGenderGap, getSalaryBands } from "@/lib/db/queries/salary";
import { getQueryClient } from "@/lib/query/server";
import { buildSalaryOutliers } from "@/lib/reports/salary-outliers";

import { SalaryClient } from "./salary-client";

export const metadata = { title: "Salary — Dante" };

export default async function SalaryPage() {
  // Drop the `minRole` arg and check explicitly so the unauthorized path
  // calls Next's `forbidden()` (clean 403 + forbidden.tsx UI) instead of
  // throwing ForbiddenError, which surfaces as a 500 in dev.
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();
  await audit(ctx, {
    action: "view_salary",
    target_type: "salary_insights",
  });

  // Prefetch the three queries salary-client.tsx issues on first render
  // (bandGrouping "tier", gapGrouping "tier", gapBasis "fix"). Keys must
  // match the hooks in lib/api/salary-insights.ts exactly; payloads are
  // what app/api/salary/{bands,outliers,gender-gap}/route.ts return.
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["salary", "bands", "tier"],
      queryFn: () => getSalaryBands("tier"),
    }),
    qc.prefetchQuery({
      queryKey: ["salary", "outliers", "tier"],
      queryFn: () => buildSalaryOutliers("tier"),
    }),
    qc.prefetchQuery({
      queryKey: ["salary", "gender-gap", "tier", "fix"],
      queryFn: () => getGenderGap("tier", "fix"),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <SalaryClient />
    </HydrationBoundary>
  );
}
