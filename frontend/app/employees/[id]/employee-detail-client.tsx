"use client";

import Link from "next/link";

import { DetailPageShell } from "@/components/layout/detail-page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryGuard } from "@/components/ui/query-guard";

import { EntityLinkCards } from "@/components/integrations/entity-link-cards";
import { EmployeeFlagsCard } from "@/components/employee/employee-flags-card";
import { EmployeeSalaryChart } from "@/components/employee/employee-salary-chart";
import { InspectDialog } from "@/components/employee/inspect-dialog";
import {
  EmployeeMonthlyCard,
  EmployeeTrendChartCard,
} from "@/components/consultant/consultant-monthly-breakdown";
import { useEmployee, useEmployeeAllocations } from "@/lib/api/employees";
import type { EmployeeDetail } from "@/lib/api/employees";
import { formatEUR } from "@/lib/format";

export function EmployeeDetailClient({
  employee_id,
}: {
  employee_id: number;
}) {
  return (
    <DetailPageShell
      params={Promise.resolve({ id: String(employee_id) })}
      useDetail={useEmployee}
    >
      {(data) => <EmployeeBody data={data} />}
    </DetailPageShell>
  );
}

function EmployeeBody({ data }: { data: EmployeeDetail }) {
  const allocations = useEmployeeAllocations(data.employee_id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/employees"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← All employees
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {data.first_name} {data.last_name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary">{data.status ?? "unknown"}</Badge>
            {data.role_tier && <Badge variant="outline">{data.role_tier}</Badge>}
            {data.team && <Badge variant="outline">{data.team}</Badge>}
            {data.position && <span>{data.position}</span>}
          </div>
        </div>
        <InspectDialog
          employeeId={data.employee_id}
          employeeName={`${data.first_name ?? ""} ${data.last_name ?? ""}`.trim()}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: personal + team + allocations */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Personal</CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValueGrid
                items={[
                  ["Email", data.email ?? "—"],
                  ["Hire date", data.hire_date ?? "—"],
                  ["Leaving date (v2)", data.employment_end_date ?? "—"],
                  ["Contract end (v1)", data.contract_end_date ?? "—"],
                  ["Probation end", data.probation_period_end ?? "—"],
                  ["Notice (probation)", data.notice_period_probation ?? "—"],
                  ["Employment type", data.employment_type ?? "—"],
                  ["FTE", data.fte ? data.fte.toFixed(2) : "—"],
                  ["Weekly hours", data.weekly_working_hours ?? "—"],
                  ["Office", data.office ?? "—"],
                  ["Cost center", data.cost_center ?? "—"],
                  ["Subcompany", data.subcompany ?? "—"],
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Org graph</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Reports to:</span>
                {data.supervisor_id ? (
                  <Link
                    href={`/employees/${data.supervisor_id}`}
                    className="font-medium hover:underline"
                  >
                    {data.supervisor_name ?? `#${data.supervisor_id}`}
                  </Link>
                ) : (
                  <span>—</span>
                )}
              </div>
              <div>
                <div className="text-muted-foreground">
                  Direct reports ({data.direct_reports?.length ?? 0}):
                </div>
                {!data.direct_reports?.length ? (
                  <div className="text-muted-foreground">—</div>
                ) : (
                  <ul className="mt-1 list-inside list-disc">
                    {data.direct_reports.map((r) => (
                      <li key={r.employee_id}>
                        <Link
                          href={`/employees/${r.employee_id}`}
                          className="hover:underline"
                        >
                          {r.first_name} {r.last_name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          <EmployeeMonthlyCard employeeId={data.employee_id} />
          <EmployeeTrendChartCard employeeId={data.employee_id} />

          <Card>
            <CardHeader>
              <CardTitle>
                Allocations ({allocations.data?.length ?? 0})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <QueryGuard query={allocations} skeletonHeight="h-24">
                {(rows) =>
                  rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Never assigned to a project.
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              Project
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Profile
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Alloc
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Rate
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                              Period
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {rows.map((a) => (
                            <tr
                              key={a.assignment_id}
                              className="hover:bg-muted/20"
                            >
                              <td className="px-3 py-2 align-top">
                                <Link
                                  href={`/projects/${a.project_id}`}
                                  className="block min-w-0 break-words hover:underline"
                                >
                                  <span className="text-muted-foreground">
                                    {a.customer_name}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {" / "}
                                  </span>
                                  <span className="font-medium">
                                    {a.project_name}
                                  </span>
                                </Link>
                                {a.is_active_today && (
                                  <Badge
                                    variant="outline"
                                    className="mt-1 bg-emerald-50 text-emerald-700"
                                  >
                                    active
                                  </Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 align-top text-muted-foreground">
                                {a.profile ?? "—"}
                              </td>
                              <td className="px-3 py-2 align-top text-right tabular-nums">
                                {Number(a.allocation_pct).toFixed(2)}
                              </td>
                              <td className="px-3 py-2 align-top whitespace-nowrap text-right tabular-nums">
                                {a.effective_daily_rate_eur
                                  ? `${formatEUR(a.effective_daily_rate_eur)}/d`
                                  : "—"}
                              </td>
                              <td className="px-3 py-2 align-top whitespace-nowrap text-muted-foreground tabular-nums">
                                <div>{a.start_date}</div>
                                <div className="text-xs">
                                  → {a.end_date ?? "open"}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </QueryGuard>
            </CardContent>
          </Card>
        </div>

        {/* Right: flags + salary chart + integration links */}
        <div className="space-y-6">
          <EmployeeFlagsCard employee={data} />
          <EntityLinkCards danteType="employee" danteId={data.employee_id} />
          <EmployeeSalaryChart employeeId={data.employee_id} />
        </div>
      </div>
    </div>
  );
}

function KeyValueGrid({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
