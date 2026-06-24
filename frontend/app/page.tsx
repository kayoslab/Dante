import Link from "next/link";

import { HomeProjectList } from "@/components/home/home-project-list";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { hasRole, requireSession } from "@/lib/auth/session";
import { listSdmProjectIdsForUser } from "@/lib/db/queries/project-sdm";

export default async function Home() {
  const ctx = await requireSession();

  // Manager/admin → all active projects with KPI badges + month nav.
  // The heavyweight portfolio rentability view (KPI grids, bench
  // breakdown, FP recognition) lives at `/reports/portfolio-rentability`.
  if (hasRole(ctx, "manager")) {
    return (
      <div className="space-y-6">
        <HomeProjectList
          title="Active projects"
          subtitle="Every active project this month. Click a row for the project detail; the rentability report has the full KPI breakdown."
        />
      </div>
    );
  }

  // Employee with SDM grants → list of their projects only. Same row
  // shape and badges as the manager view, just scoped server-side.
  const sdmGrants = await listSdmProjectIdsForUser(ctx.user_id);
  if (sdmGrants.length > 0) {
    return (
      <div className="space-y-6">
        <HomeProjectList
          title="Projects I manage"
          subtitle="Projects you have Service Delivery Manager access to. Missing-hours badge flags freelancer-assignment months without a logged entry."
        />
      </div>
    );
  }

  // Plain employee — focused welcome view pointing at the surfaces they
  // can act on. Unchanged from the previous design.
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to Dante
        </h1>
        <p className="text-sm text-muted-foreground">
          Your home for assignments, time tracking, and team visibility.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-2 py-6">
            <h2 className="text-base font-semibold">Your profile</h2>
            <p className="text-sm text-muted-foreground">
              Your core details, current assignments, and tracked time.
            </p>
            <Link
              href="/profile"
              className={buttonVariants({ size: "sm" }) + " mt-2"}
            >
              Open profile
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 py-6">
            <h2 className="text-base font-semibold">Team calendar</h2>
            <p className="text-sm text-muted-foreground">
              See who&rsquo;s on what across the team.
            </p>
            <Link
              href="/calendar"
              className={
                buttonVariants({ size: "sm", variant: "outline" }) + " mt-2"
              }
            >
              Open calendar
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
