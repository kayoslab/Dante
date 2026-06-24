import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { PortfolioRentabilityClient } from "./portfolio-rentability-client";

export const metadata = { title: "Portfolio rentability — Dante" };

// Trend + selected-month detail depend on live assignment + tracked-hours
// data; never cache.
export const dynamic = "force-dynamic";

export default async function PortfolioRentabilityPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_portfolio_rentability",
    target_type: "report",
    target_id: "portfolio_rentability",
  });

  return <PortfolioRentabilityClient />;
}
