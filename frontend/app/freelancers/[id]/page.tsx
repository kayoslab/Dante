import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { freelancerKeys } from "@/lib/api/keys";
import { getFreelancerDetail } from "@/lib/db/queries/freelancer";
import { getQueryClient } from "@/lib/query/server";

import { FreelancerDetailClient } from "./freelancer-detail-client";
import { requireSession } from "@/lib/auth/session";

export default async function FreelancerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession({ minRole: "manager" });

  const { id: rawId } = await params;
  const freelancer_id = Number(rawId);
  if (!Number.isInteger(freelancer_id)) notFound();

  const qc = getQueryClient();
  const data = await getFreelancerDetail(freelancer_id);
  if (!data) notFound();
  qc.setQueryData(freelancerKeys.detail(freelancer_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <FreelancerDetailClient freelancer_id={freelancer_id} />
    </HydrationBoundary>
  );
}
