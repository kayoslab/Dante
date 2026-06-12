import { forbidden } from "next/navigation";

import { hasRole, requireSession } from "@/lib/auth/session";
import { audit } from "@/lib/auth/audit";

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
  return <SalaryClient />;
}
