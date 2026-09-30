import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { computeForecast } from "@/lib/db/queries/forecast";
import { getQueryClient } from "@/lib/query/server";

import { ForecastClient } from "./forecast-client";

export const metadata = { title: "Forecast — Dante" };

export default async function ForecastPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_report_forecast",
    target_type: "report",
    target_id: "forecast",
  });

  // Prefetch the report so the first paint ships populated data. Key must
  // match `useForecast` in lib/api/forecast.ts exactly; the payload is
  // what app/api/reports/forecast/route.ts returns (computeForecast(today)).
  const qc = getQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  await qc.prefetchQuery({
    queryKey: ["reports", "forecast"],
    queryFn: () => computeForecast(today),
  });

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <ForecastClient />
    </HydrationBoundary>
  );
}
