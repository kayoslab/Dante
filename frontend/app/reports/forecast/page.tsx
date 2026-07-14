import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { ForecastClient } from "./forecast-client";

export const metadata = { title: "Forecast — Dante" };

// Depends on live assignment + tracked-hours data; never cache.
export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_report_forecast",
    target_type: "report",
    target_id: "forecast",
  });

  return <ForecastClient />;
}
