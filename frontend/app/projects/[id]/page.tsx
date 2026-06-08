import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { projectKeys } from "@/lib/api/keys";
import { getProjectDetail } from "@/lib/db/queries/project";
import { getQueryClient } from "@/lib/query/server";

import { ProjectDetailClient } from "./project-detail-client";
import { requireSession } from "@/lib/auth/session";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession({ minRole: "manager" });

  const { id: rawId } = await params;
  const project_id = Number(rawId);
  if (!Number.isInteger(project_id)) notFound();

  const qc = getQueryClient();
  const data = await getProjectDetail(project_id);
  if (!data) notFound();
  qc.setQueryData(projectKeys.detail(project_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <ProjectDetailClient project_id={project_id} />
    </HydrationBoundary>
  );
}
