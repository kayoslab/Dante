import { HydrationBoundary, dehydrate } from "@tanstack/react-query";

import { CustomerTable } from "@/components/customer/customer-table";
import { AddCustomerDialog } from "@/components/customer/add-customer-dialog";
import { listCustomers } from "@/lib/db/queries/customer-list";
import { getQueryClient } from "@/lib/query/server";
import { requireSession } from "@/lib/auth/session";

export const metadata = { title: "Customers — Dante" };

export default async function CustomersPage() {
  await requireSession({ minRole: "manager" });

  // Phase D.2: prefetch the default sort/order so the first paint ships
  // populated rows. `useCustomers` on the client picks up the same query
  // key (`['customers', { sort: 'name', order: 'asc' }]`) and finds the
  // data already in cache — no loading flash, no refetch on mount.
  const qc = getQueryClient();
  await qc.prefetchQuery({
    queryKey: ["customers", { sort: "name", order: "asc" }],
    queryFn: () => listCustomers({ sort: "name", order: "asc" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <AddCustomerDialog />
      </div>
      <HydrationBoundary state={dehydrate(qc)}>
        <CustomerTable />
      </HydrationBoundary>
    </div>
  );
}
