import { requireSession } from "@/lib/auth/session";
import { audit } from "@/lib/auth/audit";

import { SalaryClient } from "./salary-client";

export const metadata = { title: "Salary — Dante" };

export default async function SalaryPage() {
  const ctx = await requireSession({ minRole: "manager" });
  await audit(ctx, {
    action: "view_salary",
    target_type: "salary_insights",
  });
  return <SalaryClient />;
}
