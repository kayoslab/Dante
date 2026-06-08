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

  const qc = getQueryClient();
  // Prefetch the default filter view (status=active, no search, no team)
  // and the team-list dropdown. Filter changes on the client refetch
  // through TanStack as normal.
  await Promise.all([
    qc.prefetchQuery({
      queryKey: [
        "employees",
        "list",
        { q: undefined, team: undefined, status: "active" },
      ],
      queryFn: () => listEmployees({ status: "active" }),
    }),
    qc.prefetchQuery({
      queryKey: ["employees", "teams"],
      queryFn: () => listEmployeeTeams(),
    }),
  ]);

  return (
    <div className="space-y-6">
      <HydrationBoundary state={dehydrate(qc)}>
        <EmployeesListClient
          canViewDetail={hasRole(ctx, "manager")}
          ownEmployeeId={ctx.employee_id}
        />
      </HydrationBoundary>
    </div>
  );
}
