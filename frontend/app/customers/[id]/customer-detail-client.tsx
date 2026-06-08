"use client";

import Link from "next/link";

import { DetailPageShell } from "@/components/layout/detail-page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCustomer } from "@/lib/api/customers";
import { DeleteCustomerDialog } from "@/components/customer/delete-customer-dialog";
import { EditCustomerDialog } from "@/components/customer/edit-customer-dialog";
import { AddFrameworkDialog } from "@/components/framework/add-framework-dialog";
import { AddProjectDialog } from "@/components/project/add-project-dialog";

export function CustomerDetailClient({ customer_id }: { customer_id: number }) {
  return (
    <DetailPageShell
      params={Promise.resolve({ id: String(customer_id) })}
      useDetail={useCustomer}
    >
      {(data) => {
        const hasChildren =
          data.frameworks.length > 0 || data.projects.length > 0;
        return (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Link
                  href="/customers"
                  className="text-sm text-muted-foreground hover:underline"
                >
                  ← Customers
                </Link>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                  {data.name}
                </h1>
                {data.notes && (
                  <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                    {data.notes}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <EditCustomerDialog
                  customerId={data.customer_id}
                  initial={{ name: data.name, notes: data.notes }}
                />
                <DeleteCustomerDialog
                  customerId={data.customer_id}
                  name={data.name}
                  hasChildren={hasChildren}
                />
              </div>
            </div>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>
                  Framework agreements ({data.frameworks.length})
                </CardTitle>
                <AddFrameworkDialog customerId={data.customer_id} />
              </CardHeader>
              <CardContent>
                {data.frameworks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No framework agreements yet.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {data.frameworks.map((f) => (
                      <li key={f.framework_id} className="py-2">
                        <Link
                          href={`/frameworks/${f.framework_id}`}
                          className="font-medium hover:underline"
                        >
                          {f.name}
                        </Link>
                        <span className="ml-2 text-sm text-muted-foreground">
                          {f.start_date ?? "—"} → {f.end_date ?? "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Projects ({data.projects.length})</CardTitle>
                <AddProjectDialog
                  customerId={data.customer_id}
                  frameworks={data.frameworks}
                />
              </CardHeader>
              <CardContent>
                {data.projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No projects yet.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {data.projects.map((p) => (
                      <li
                        key={p.project_id}
                        className="flex items-center justify-between py-2"
                      >
                        <Link
                          href={`/projects/${p.project_id}`}
                          className="font-medium hover:underline"
                        >
                          {p.name}
                        </Link>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{p.billing_model}</Badge>
                          <Badge variant="secondary">{p.status}</Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </DetailPageShell>
  );
}
