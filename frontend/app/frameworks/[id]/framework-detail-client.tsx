"use client";

import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { DetailPageShell } from "@/components/layout/detail-page-shell";
import { useFramework, useDeleteFrameworkRate } from "@/lib/api/frameworks";
import { AddRateDialog } from "@/components/framework/add-rate-dialog";
import { EditFrameworkDialog } from "@/components/framework/edit-framework-dialog";
import { EditRateDialog } from "@/components/framework/edit-rate-dialog";
import { DeleteFrameworkDialog } from "@/components/framework/delete-framework-dialog";
import { formatRate } from "@/lib/format";

export function FrameworkDetailClient({
  framework_id,
}: {
  framework_id: number;
}) {
  return (
    <DetailPageShell
      params={Promise.resolve({ id: String(framework_id) })}
      useDetail={useFramework}
    >
      {(data) => <FrameworkContent data={data} />}
    </DetailPageShell>
  );
}

function FrameworkContent({
  data,
}: {
  data: NonNullable<ReturnType<typeof useFramework>["data"]>;
}) {
  const delRate = useDeleteFrameworkRate(data.framework_id);
  const hasChildren = data.rates.length > 0;

  // Group rates by profile, sorted by valid_from
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
            ← Customer
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {data.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.start_date ?? "—"} → {data.end_date ?? "—"}
          </p>
          {data.notes && (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {data.notes}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <EditFrameworkDialog
            frameworkId={data.framework_id}
            customerId={data.customer_id}
            initial={{
              name: data.name,
              start_date: data.start_date,
              end_date: data.end_date,
              notes: data.notes,
            }}
          />
          <DeleteFrameworkDialog
            frameworkId={data.framework_id}
            customerId={data.customer_id}
            name={data.name}
            hasChildren={hasChildren}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Rates ({data.rates.length})</CardTitle>
          <AddRateDialog
            parent="framework"
            framework_id={data.framework_id}
            defaultValidFrom={data.start_date ?? undefined}
          />
        </CardHeader>
        <CardContent>
          {data.rates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rates yet. Add rates per profile (e.g. junior, senior, expert).
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
                            parent="framework"
                            framework_id={data.framework_id}
                            profile={r.profile}
                            valid_from={r.valid_from}
                            currentRate={r.daily_rate_eur}
                          />
                          <ConfirmDeleteButton
                            title={`Delete rate for "${r.profile}"?`}
                            description={`Effective from ${r.valid_from}. This cannot be undone.`}
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
  );
}
