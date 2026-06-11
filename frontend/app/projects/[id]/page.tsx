import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden, notFound } from "next/navigation";

import { projectKeys } from "@/lib/api/keys";
import { getProjectDetail } from "@/lib/db/queries/project";
import { getQueryClient } from "@/lib/query/server";
import { requireSession } from "@/lib/auth/session";
import { canManageProject } from "@/lib/auth/project-capability";

import { ProjectDetailClient } from "./project-detail-client";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Drop minRole to employee — SDMs (employees with project_sdm grants)
  // can reach this page for their projects. The check below enforces
  // per-project access.
  const ctx = await requireSession({ minRole: "employee" });

  const { id: rawId } = await params;
  const project_id = Number(rawId);
  if (!Number.isInteger(project_id)) notFound();
  if (!(await canManageProject(ctx, project_id))) forbidden();

  const qc = getQueryClient();
  const data = await getProjectDetail(project_id);
  if (!data) notFound();
  qc.setQueryData(projectKeys.detail(project_id), data);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <ProjectDetailClient project_id={project_id} viewer_role={ctx.role} />
    </HydrationBoundary>
  );
}
