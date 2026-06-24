import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { UtilizationClient } from "./utilization-client";

export const metadata = { title: "Utilization — Dante" };

// Trend + selected-month detail depend on live assignment data; never cache.
export const dynamic = "force-dynamic";

export default async function UtilizationPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_utilization",
    target_type: "report",
    target_id: "utilization",
  });

  return <UtilizationClient />;
}
