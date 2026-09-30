"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { DetailPageShell } from "@/components/layout/detail-page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";

import {
  useFreelancer,
  useDeleteFreelancer,
} from "@/lib/api/freelancers";
import { EditFreelancerDialog } from "@/components/freelancer/edit-freelancer-dialog";
import { FreelancerMonthlyCard } from "@/components/consultant/consultant-monthly-breakdown";
import { formatRate } from "@/lib/format";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// Chart components pull in recharts (~400 KB minified). Load them on
// demand so the page shell, KPIs and tables paint without it.
const FreelancerTrendChartCard = dynamic(
  () => import("@/components/consultant/consultant-trend-chart").then((m) => m.FreelancerTrendChartCard),
  { loading: () => <Skeleton className="h-96 w-full" /> },
);

export function FreelancerDetailClient({
  freelancer_id,
}: {
  freelancer_id: number;
}) {
  const router = useRouter();
  const del = useDeleteFreelancer();

  return (
    <DetailPageShell
      params={Promise.resolve({ id: String(freelancer_id) })}
      useDetail={useFreelancer}
    >
      {(data) => (
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Link
                href="/freelancers"
                className="text-sm text-muted-foreground hover:underline"
              >
                ← Freelancers
              </Link>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                {data.name}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={data.status === "active" ? "secondary" : "outline"}
                >
                  {data.status}
                </Badge>
                <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatRate(data.daily_cost_eur)}/day
                </span>
                {data.contact_email && (
                  <a
                    href={`mailto:${data.contact_email}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {data.contact_email}
                  </a>
                )}
              </div>
              {data.notes && (
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  {data.notes}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <EditFreelancerDialog
                freelancerId={data.freelancer_id}
                initial={{
                  name: data.name,
                  daily_cost_eur: data.daily_cost_eur,
                  contact_email: data.contact_email,
                  status: data.status,
                  notes: data.notes,
                }}
              />
              <ConfirmDeleteButton
                iconOnly={false}
                title={`Delete freelancer "${data.name}"?`}
                description="If this freelancer is on any assignments, deletion will fail unless you also remove those assignments first. This cannot be undone."
                successMessage={`Freelancer "${data.name}" deleted`}
                onConfirm={async () => {
                  await del.mutateAsync({
                    freelancer_id: data.freelancer_id,
                    force: false,
                  });
                  router.push("/freelancers");
                }}
              />
            </div>
          </div>

          <FreelancerMonthlyCard freelancerId={data.freelancer_id} />
          <FreelancerTrendChartCard freelancerId={data.freelancer_id} />

          <Card>
            <CardHeader>
              <CardTitle>Created</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {new Date(data.created_at).toLocaleString("de-DE")}
            </CardContent>
          </Card>
        </div>
      )}
    </DetailPageShell>
  );
}
