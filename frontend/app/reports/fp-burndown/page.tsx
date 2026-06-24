import { forbidden } from "next/navigation";

import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

import { FpBurndownClient } from "./fp-burndown-client";

export const metadata = { title: "Fixed-price burn-down — Dante" };
export const dynamic = "force-dynamic";

export default async function FpBurndownPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_fp_burndown",
    target_type: "report",
    target_id: "fp_burndown",
  });

  return <FpBurndownClient />;
}
