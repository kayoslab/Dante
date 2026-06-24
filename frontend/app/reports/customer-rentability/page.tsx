import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { CustomerRentabilityClient } from "./customer-rentability-client";

export const metadata = { title: "Customer rentability — Dante" };
export const dynamic = "force-dynamic";

export default async function CustomerRentabilityPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_customer_rentability",
    target_type: "report",
    target_id: "customer_rentability",
  });

  return <CustomerRentabilityClient />;
}
