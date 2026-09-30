"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeMonthly } from "@/lib/api/employees";
import { useFreelancerMonthly } from "@/lib/api/freelancers";
import { formatEUR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";

type AssignmentRow = {
  assignment_id: number;
  project_id: number;
  project_name: string;
  customer_name: string;
  billing_model: "time_and_material" | "fixed_price";
  profile?: string | null;
  allocation_pct: string;
  active_working_days: number;
  absence_days: number;
  billable_days: number;
  revenue: string;
  rate_unresolved_days: number;
  cost?: string;   // freelancer only
};

export function EmployeeMonthlyCard({ employeeId }: { employeeId: number }) {
  const [month, setMonth] = useState<string>(() => isoMonthOf(new Date()));
  const { data, isLoading, isError, error } = useEmployeeMonthly(
    employeeId,
    month,
  );
  return (
    <ConsultantMonthlyCard
      title="Personal P&L"
      month={month}
      onMonthChange={setMonth}
      isLoading={isLoading}
      isError={isError}
      error={error}
    >
      {data && (
        <EmployeeBody data={data} />
      )}
    </ConsultantMonthlyCard>
  );
}

export function FreelancerMonthlyCard({
  freelancerId,
}: {
  freelancerId: number;
}) {
  const [month, setMonth] = useState<string>(() => isoMonthOf(new Date()));
  const { data, isLoading, isError, error } = useFreelancerMonthly(
    freelancerId,
    month,
  );
  return (
    <ConsultantMonthlyCard
      title="Monthly P&L"
      month={month}
      onMonthChange={setMonth}
      isLoading={isLoading}
      isError={isError}
      error={error}
    >
      {data && <FreelancerBody data={data} />}
    </ConsultantMonthlyCard>
  );
}

function ConsultantMonthlyCard({
  title,
  month,
  onMonthChange,
  isLoading,
  isError,
  error,
  children,
}: {
  title: string;
  month: string;
  onMonthChange: (m: string) => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  children: React.ReactNode;
}) {
  const todayMonth = isoMonthOf(new Date());
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMonthChange(shiftMonth(month, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMonthChange(todayMonth)}
              disabled={month === todayMonth}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMonthChange(shiftMonth(month, +1))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="text-sm font-medium text-foreground">
          {monthLabel(month)}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function EmployeeBody({
  data,
}: {
  data: NonNullable<ReturnType<typeof useEmployeeMonthly>["data"]>;
}) {
  if (!data.under_contract) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">Not under contract this month</div>
        <div className="mt-1">
          {data.hire_date && <>Hired {data.hire_date}</>}
          {data.hire_date && data.employment_end_date && " · "}
          {data.employment_end_date && <>Left {data.employment_end_date}</>}
        </div>
      </div>
    );
  }
  const margin = Number(data.margin);
  const marginTone = margin >= 0 ? "positive" : "negative";
  const util = Number(data.utilization_pct);
  const utilLabel = `${(util * 100).toFixed(0)}%`;
  return (
    <div className="space-y-5">
      <KpiGrid>
        <Kpi
          label="Loaded cost"
          value={
            data.monthly_cost_full ? formatEUR(data.monthly_cost_full) : "—"
          }
          emphasize
          hint={data.monthly_cost_basis}
        />
        <Kpi
          label="Revenue"
          value={formatEUR(data.revenue)}
          emphasize
          hint={
            data.allocation_revenue &&
            Number(data.allocation_revenue) - Number(data.revenue) > 1
              ? `Billable revenue (tracked × rate). Allocation projected ${formatEUR(data.allocation_revenue)} — ${formatEUR((Number(data.allocation_revenue) - Number(data.revenue)).toFixed(2))} not yet tracked.`
              : "Billable revenue: tracked hours × rate (T&M) + recognized share (FP). Allocation alone doesn't bill."
          }
        />
        <Kpi
          label="Margin"
          value={formatEUR(data.margin)}
          emphasize
          tone={marginTone}
        />
        <Kpi
          label="Margin %"
          value={formatPercent(data.margin_pct)}
          emphasize
          tone={marginTone}
          hint="(Revenue − Cost) / Cost. −100% = no revenue covered any payroll; 0% = break-even; +N% = revenue exceeded payroll by N%. Cost-based so a tiny revenue doesn't produce a misleading −500%+ figure."
        />
      </KpiGrid>
      <KpiGrid>
        <Kpi
          label="Utilization"
          value={utilLabel}
          hint="Σ weighted allocation across this consultant's assignments this month. 100% = fully booked. Bench drag shows up as the gap below 100%."
        />
        <Kpi label="FTE" value={Number(data.fte).toFixed(2)} />
        <Kpi
          label="Working days"
          value={data.working_days_in_month}
        />
        <Kpi
          label="Total absences"
          value={data.assignments.reduce(
            (s: number, a) => s + a.absence_days,
            0,
          )}
        />
      </KpiGrid>
      {data.rate_unresolved_days > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {data.rate_unresolved_days} billable day
            {data.rate_unresolved_days === 1 ? "" : "s"} without a resolved
            rate — revenue contribution silently zero for those days.
          </div>
        </div>
      )}
      <AssignmentTable rows={data.assignments} showCostCol={false} />
    </div>
  );
}

function FreelancerBody({
  data,
}: {
  data: NonNullable<ReturnType<typeof useFreelancerMonthly>["data"]>;
}) {
  const margin = Number(data.margin);
  const marginTone = margin >= 0 ? "positive" : "negative";
  return (
    <div className="space-y-5">
      <KpiGrid>
        <Kpi label="Cost" value={formatEUR(data.cost)} emphasize />
        <Kpi label="Revenue" value={formatEUR(data.revenue)} emphasize />
        <Kpi
          label="Margin"
          value={formatEUR(data.margin)}
          emphasize
          tone={marginTone}
        />
        <Kpi
          label="Margin %"
          value={formatPercent(data.margin_pct)}
          emphasize
          tone={marginTone}
        />
      </KpiGrid>
      <div className="text-xs text-muted-foreground">
        Freelancer cost = Σ daily_cost × active days × allocation. They are
        only paid for days assigned, so there is no bench drag.
      </div>
      {data.rate_unresolved_days > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {data.rate_unresolved_days} billable day
            {data.rate_unresolved_days === 1 ? "" : "s"} without a resolved
            rate — revenue contribution silently zero for those days.
          </div>
        </div>
      )}
      <AssignmentTable rows={data.assignments} showCostCol />
    </div>
  );
}

function AssignmentTable({
  rows,
  showCostCol,
}: {
  rows: AssignmentRow[];
  showCostCol: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No assignments active in this month.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Customer / Project</th>
            <th className="px-3 py-2 text-left font-medium">Model</th>
            <th className="px-3 py-2 text-left font-medium">Profile</th>
            <th className="px-3 py-2 text-right font-medium">Alloc</th>
            <th className="px-3 py-2 text-right font-medium">Days</th>
            <th className="px-3 py-2 text-right font-medium">Absent</th>
            <th className="px-3 py-2 text-right font-medium">Billable</th>
            <th className="px-3 py-2 text-right font-medium">Revenue</th>
            {showCostCol && (
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((a) => (
            <tr key={a.assignment_id} className="hover:bg-muted/20">
              <td className="px-3 py-2">
                <Link
                  href={`/projects/${a.project_id}`}
                  className="hover:underline"
                >
                  <span className="text-muted-foreground">
                    {a.customer_name}
                  </span>
                  <span className="text-muted-foreground"> / </span>
                  <span>{a.project_name}</span>
                </Link>
                {a.rate_unresolved_days > 0 && (
                  <span
                    title={`${a.rate_unresolved_days} billable day(s) without a resolved rate — revenue silently zero.`}
                    className="ml-2 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {a.rate_unresolved_days}d
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <Badge variant="outline">
                  {a.billing_model === "time_and_material" ? "T&M" : "FP"}
                </Badge>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {a.profile ?? "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(a.allocation_pct).toFixed(2)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {a.active_working_days}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {a.absence_days}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {a.billable_days.toFixed(1)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatEUR(a.revenue)}
              </td>
              {showCostCol && (
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatEUR(a.cost)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
