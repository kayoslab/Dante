import { HydrationBoundary, dehydrate } from "@tanstack/react-query";

import { EmployeesListClient } from "@/components/employee/employees-list-client";
import {
  listEmployeeTeams,
  listEmployees,
} from "@/lib/db/queries/employee-list";
import { getQueryClient } from "@/lib/query/server";
import { hasRole, requireSession } from "@/lib/auth/session";

export const metadata = { title: "Employees — Dante" };

export default async function EmployeesPage() {
  const ctx = await requireSession();
  const isManagerOrAdmin = hasRole(ctx, "manager");

  const qc = getQueryClient();
  // Prefetch the team-list dropdown for everyone (just team names) and
  // — only for manager+ — the default filter view (status=active).
  //
  // Plain employees skip the list prefetch on purpose: the prefetched
  // result lands in the dehydrated TanStack cache, which gets serialized
  // into the page HTML for hydration. Server-side `listEmployees` returns
  // HR-sensitive fields (role_tier, position, is_real_employee,
  // contract_end_date, …) that the /api/employees route strips for
  // non-managers; the SSR cache would ship them unredacted in the
  // hydration payload. The client query at `useEmployees` hits the
  // API instead, which applies the redaction. Cost: one extra round
  // trip on first paint, which for ~30 internal users is acceptable.
  const prefetches: Promise<void>[] = [
    qc.prefetchQuery({
      queryKey: ["employees", "teams"],
      queryFn: () => listEmployeeTeams(),
    }),
  ];
  if (isManagerOrAdmin) {
    prefetches.push(
      qc.prefetchQuery({
        queryKey: [
          "employees",
          "list",
          { q: undefined, team: undefined, status: "active" },
        ],
        queryFn: () => listEmployees({ status: "active" }),
      }),
    );
  }
  await Promise.all(prefetches);

  return (
    <div className="space-y-6">
      <HydrationBoundary state={dehydrate(qc)}>
        <EmployeesListClient
          canViewDetail={isManagerOrAdmin}
          ownEmployeeId={ctx.employee_id}
        />
      </HydrationBoundary>
    </div>
  );
}
