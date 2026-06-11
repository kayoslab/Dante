"use client";

import Link from "next/link";

import { DetailPageShell } from "@/components/layout/detail-page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";

import { useProject, useDeleteProjectRate } from "@/lib/api/projects";
import type { ProjectDetail } from "@/lib/api/projects";
import { useCustomer } from "@/lib/api/customers";
import { AddRateDialog } from "@/components/framework/add-rate-dialog";
import { EditRateDialog } from "@/components/framework/edit-rate-dialog";
import { DeleteProjectDialog } from "@/components/project/delete-project-dialog";
import { EditProjectDialog } from "@/components/project/edit-project-dialog";
import { FreelancerHoursCard } from "@/components/project/freelancer-hours-card";
import { MergeProjectDialog } from "@/components/project/merge-project-dialog";
import { ProjectSdmCard } from "@/components/project/project-sdm-card";
import { ProjectEconomicsCard } from "@/components/project/project-economics";
import { AworkLinkCard } from "@/components/project/awork-link-card";
import { PersonioLinkCard } from "@/components/project/personio-link-card";
import { ProjectLoggedTimeCard } from "@/components/project/project-logged-time-card";
import { ProjectMonthlyBreakdownCard } from "@/components/project/project-monthly-breakdown";
import { ProjectTrendChart } from "@/components/project/project-trend-chart";
import { AddAssignmentDialog } from "@/components/assignment/add-assignment-dialog";
import { AssignmentsTable } from "@/components/assignment/assignments-table";
import { formatEUR, formatRate } from "@/lib/format";

export function ProjectDetailClient({
  project_id,
  viewer_role,
}: {
  project_id: number;
  viewer_role: "admin" | "manager" | "employee";
}) {
  return (
    <DetailPageShell
      params={Promise.resolve({ id: String(project_id) })}
      useDetail={useProject}
    >
      {(data) => <ProjectBody data={data} viewer_role={viewer_role} />}
    </DetailPageShell>
  );
}

function ProjectBody({
  data,
  viewer_role,
}: {
  data: ProjectDetail;
  viewer_role: "admin" | "manager" | "employee";
}) {
  const delRate = useDeleteProjectRate(data.project_id);
  const { data: customer } = useCustomer(data.customer_id);

  const hasChildren = data.rates.length > 0 || data.assignments.length > 0;
  const ratesByProfile = data.rates.reduce<Record<string, typeof data.rates>>(
    (acc, r) => {
      (acc[r.profile] ??= []).push(r);
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href={`/customers/${data.customer_id}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← {data.customer_name}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {data.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{data.billing_model}</Badge>
            <Badge variant="secondary">{data.status}</Badge>
            {data.framework_id && (
              <Link
                href={`/frameworks/${data.framework_id}`}
                className="text-muted-foreground hover:underline"
              >
                framework: {data.framework_name}
              </Link>
            )}
            <span className="text-muted-foreground">
              {data.planned_start_date ?? "—"} → {data.planned_end_date ?? "—"}
            </span>
            {data.agreed_amount_eur && (
              <span className="text-muted-foreground">
                agreed {formatEUR(data.agreed_amount_eur)}
              </span>
            )}
          </div>
          {data.notes && (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {data.notes}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <EditProjectDialog
            projectId={data.project_id}
            customerId={data.customer_id}
            initial={{
              name: data.name,
              framework_id: data.framework_id,
              agreed_amount_eur: data.agreed_amount_eur,
              planned_start_date: data.planned_start_date,
              planned_end_date: data.planned_end_date,
              status: data.status,
              notes: data.notes,
            }}
            frameworks={customer?.frameworks ?? []}
          />
          <MergeProjectDialog
            targetProjectId={data.project_id}
            customerId={data.customer_id}
            targetName={data.name}
          />
          <DeleteProjectDialog
            projectId={data.project_id}
            customerId={data.customer_id}
            name={data.name}
            hasChildren={hasChildren}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Assignments ({data.assignments.length})</CardTitle>
              <AddAssignmentDialog project_id={data.project_id} />
            </CardHeader>
            <CardContent>
              <AssignmentsTable
                project_id={data.project_id}
                assignments={data.assignments}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Project rate overrides ({data.rates.length})</CardTitle>
              <AddRateDialog
                parent="project"
                project_id={data.project_id}
                defaultValidFrom={data.planned_start_date ?? undefined}
              />
            </CardHeader>
            <CardContent>
              {data.rates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No project-level rates. The framework rate will be used if one
                  is linked.
                </p>
              ) : (
                <div className="space-y-4">
                  {Object.entries(ratesByProfile).map(([profile, versions]) => (
                    <div key={profile}>
                      <h3 className="text-sm font-medium">{profile}</h3>
                      <ul className="mt-1 divide-y rounded border">
                        {versions.map((r) => (
                          <li
                            key={`${r.profile}-${r.valid_from}`}
                            className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                          >
                            <span className="text-muted-foreground tabular-nums">
                              from {r.valid_from}
                            </span>
                            <span className="ml-auto whitespace-nowrap font-medium tabular-nums">
                              {formatRate(r.daily_rate_eur)}/day
                            </span>
                            <div className="flex gap-1">
                              <EditRateDialog
                                parent="project"
                                project_id={data.project_id}
                                profile={r.profile}
                                valid_from={r.valid_from}
                                currentRate={r.daily_rate_eur}
                              />
                              <ConfirmDeleteButton
                                title={`Delete project rate for "${r.profile}"?`}
                                description={`Effective from ${r.valid_from}. The framework rate (if any) will be used instead. This cannot be undone.`}
                                successMessage="Rate deleted"
                                onConfirm={() =>
                                  delRate.mutateAsync({
                                    profile: r.profile,
                                    valid_from: r.valid_from,
                                  })
                                }
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <ProjectEconomicsCard economics={data.economics} />
          <PersonioLinkCard projectId={data.project_id} />
          <AworkLinkCard projectId={data.project_id} />
          <ProjectSdmCard
            projectId={data.project_id}
            viewerRole={viewer_role}
          />
        </div>
      </div>

      <FreelancerHoursCard
        projectId={data.project_id}
        assignments={data.assignments}
      />

      <ProjectLoggedTimeCard projectId={data.project_id} />

      <ProjectMonthlyBreakdownCard projectId={data.project_id} />

      <ProjectTrendChart projectId={data.project_id} />
    </div>
  );
}
