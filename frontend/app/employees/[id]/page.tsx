import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { employeeKeys } from "@/lib/api/keys";
import { getEmployeeDetail } from "@/lib/db/queries/employee";
import { getQueryClient } from "@/lib/query/server";

import { EmployeeDetailClient } from "./employee-detail-client";
import { requireSession } from "@/lib/auth/session";
import { audit } from "@/lib/auth/audit";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireSession({ minRole: "manager" });

  const { id: rawId } = await params;
  const employee_id = Number(rawId);
  if (!Number.isInteger(employee_id)) notFound();

  await audit(ctx, {
    action: "view_employee_detail",
    target_type: "employee",
    target_id: employee_id,
  });

  const qc = getQueryClient();
  const data = await getEmployeeDetail(employee_id);
  if (!data) notFound();
  qc.setQueryData(employeeKeys.detail(employee_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <EmployeeDetailClient employee_id={employee_id} />
    </HydrationBoundary>
  );
}
