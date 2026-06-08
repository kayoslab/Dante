import { HydrationBoundary, dehydrate } from "@tanstack/react-query";

import { FreelancersTable } from "@/components/freelancer/freelancers-table";
import { AddFreelancerDialog } from "@/components/freelancer/add-freelancer-dialog";
import { listFreelancers } from "@/lib/db/queries/freelancer-list";
import { getQueryClient } from "@/lib/query/server";
import { requireSession } from "@/lib/auth/session";

export const metadata = { title: "Freelancers — Dante" };

export default async function FreelancersPage() {
  await requireSession({ minRole: "manager" });

  // Prefetch the default (no-filter) freelancer list; useFreelancers()
  // without args hits the same query key.
  const qc = getQueryClient();
  await qc.prefetchQuery({
    queryKey: ["freelancers", { status: undefined }],
    queryFn: () => listFreelancers(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Freelancers</h1>
        <AddFreelancerDialog />
      </div>
      <HydrationBoundary state={dehydrate(qc)}>
        <FreelancersTable />
      </HydrationBoundary>
    </div>
  );
}
