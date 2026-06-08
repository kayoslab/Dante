import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { frameworkKeys } from "@/lib/api/keys";
import { getFrameworkDetail } from "@/lib/db/queries/framework";
import { getQueryClient } from "@/lib/query/server";

import { FrameworkDetailClient } from "./framework-detail-client";
import { requireSession } from "@/lib/auth/session";

export default async function FrameworkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession({ minRole: "manager" });

  const { id: rawId } = await params;
  const framework_id = Number(rawId);
  if (!Number.isInteger(framework_id)) notFound();

  const qc = getQueryClient();
  const data = await getFrameworkDetail(framework_id);
  if (!data) notFound();
  qc.setQueryData(frameworkKeys.detail(framework_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <FrameworkDetailClient framework_id={framework_id} />
    </HydrationBoundary>
  );
}
