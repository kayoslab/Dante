import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { customerKeys } from "@/lib/api/keys";
import { getCustomerDetail } from "@/lib/db/queries/customer";
import { getQueryClient } from "@/lib/query/server";

import { CustomerDetailClient } from "./customer-detail-client";
import { requireSession } from "@/lib/auth/session";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession({ minRole: "manager" });

  const { id: rawId } = await params;
  const customer_id = Number(rawId);
  if (!Number.isInteger(customer_id)) notFound();

  const qc = getQueryClient();
  const data = await getCustomerDetail(customer_id);
  if (!data) notFound();
  qc.setQueryData(customerKeys.detail(customer_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <CustomerDetailClient customer_id={customer_id} />
    </HydrationBoundary>
  );
}
