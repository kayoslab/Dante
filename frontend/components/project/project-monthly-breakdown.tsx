"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectMonthly } from "@/lib/api/projects";
import { formatEUR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";

export function ProjectMonthlyBreakdownCard({
  projectId,
}: {
  projectId: number;
}) {
  const [month, setMonth] = useState<string>(() => isoMonthOf(new Date()));
  const { data, isLoading, isError, error } = useProjectMonthly(projectId, month);
  const todayMonth = isoMonthOf(new Date());

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Monthly breakdown</CardTitle>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(todayMonth)}
              disabled={month === todayMonth}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMonth(shiftMonth(month, +1))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{monthLabel(month)}</span>
          {data && (
            <>
              <span>·</span>
              <span>{data.working_days_in_month} working days</span>
              <Badge variant="outline" className="ml-auto">
                {data.billing_model === "time_and_material" ? "T&M" : "Fixed price"}
              </Badge>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        )}
        {data && data.rate_unresolved_days > 0 && (
          <RateGapBanner days={data.rate_unresolved_days} />
        )}
        {data && data.billing_model === "time_and_material" && (
          <TmBreakdown data={data} />
        )}
        {data && data.billing_model === "fixed_price" && (
          <FpBreakdown data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function TmBreakdown({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const margin = data.margin ? Number(data.margin) : null;
  const marginTone = margin === null ? null : margin >= 0 ? "positive" : "negative";

  return (
    <div className="space-y-5">
      <KpiGrid>
        <Kpi label="Revenue" value={formatEUR(data.revenue)} emphasize />
        <Kpi label="Cost" value={formatEUR(data.cost)} emphasize />
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
      <AssignmentTable data={data} mode="tm" />
      <UnassignedTrackedTable data={data} />
    </div>
  );
}

function FpBreakdown({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const remaining = data.remaining_budget ? Number(data.remaining_budget) : null;
  const remainingTone =
    remaining === null ? null : remaining >= 0 ? "positive" : "negative";

  return (
    <div className="space-y-5">
      <KpiGrid>
        <Kpi
          label="Agreed amount"
          value={
            data.agreed_amount_eur ? formatEUR(data.agreed_amount_eur) : "—"
          }
          emphasize
        />
        <Kpi label="Cost this month" value={formatEUR(data.cost)} emphasize />
        <Kpi
          label="Cumulative cost"
          value={formatEUR(data.cumulative_cost)}
          emphasize
        />
        <Kpi
          label="Remaining budget"
          value={
            data.remaining_budget !== null
              ? formatEUR(data.remaining_budget)
              : "—"
          }
          emphasize
          tone={remainingTone}
        />
      </KpiGrid>
      <FpRecognitionBlock data={data} />
      <FpProgressBar data={data} />
      <KpiGrid className="rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-3">
        <Kpi
          label="Burdened cost"
          value={formatEUR(data.burdened_cost)}
          emphasize
        />
        <div className="sm:col-span-3 text-xs leading-snug text-muted-foreground">
          Fully-loaded cost for the month: each consultant&apos;s full salary
          distributed across their active projects by share-of-allocation.
          Bench time and vacation get absorbed by the live projects. Compare
          against <span className="font-medium">Cost this month</span> — when
          burdened &gt; direct, the gap is bench drag this project is
          quietly carrying.
        </div>
      </KpiGrid>
      <AssignmentTable data={data} mode="fp" />
      <UnassignedTrackedTable data={data} />
    </div>
  );
}

function FpRecognitionBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const method = data.recognition_method;
  if (method === "none" || method == null) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-3 text-xs text-muted-foreground">
        No revenue recognition rule available. Set{" "}
        <span className="font-medium">time_budget_hours</span> or a{" "}
        <span className="font-medium">planned start/end</span> on the project
        to enable recognized revenue and margin.
      </div>
    );
  }
  const recMargin = data.recognized_margin ? Number(data.recognized_margin) : null;
  const recMarginTone =
    recMargin === null ? null : recMargin >= 0 ? "positive" : "negative";
  const cumMargin = data.cumulative_margin ? Number(data.cumulative_margin) : null;
  const cumMarginTone =
    cumMargin === null ? null : cumMargin >= 0 ? "positive" : "negative";
  const methodLabel =
    method === "tracked_hours"
      ? "tracked hours vs. time budget"
      : "linear over planned window";

  return (
    <div className="space-y-3 rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Revenue recognition
        </div>
        <div className="flex items-center gap-2">
          {data.over_budget && (
            <span
              className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800"
              title="Tracked hours have exceeded the time budget. Recognized revenue is capped at the agreed amount; further effort lands as pure cost."
            >
              over budget
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            via {methodLabel}
          </span>
        </div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Lifetime (real-money P&amp;L)
        </div>
        <KpiGrid>
          <Kpi
            label="Cumulative recognized"
            value={formatEUR(data.cumulative_recognized_revenue)}
            emphasize
          />
          <Kpi
            label="Cumulative cost"
            value={formatEUR(data.cumulative_cost)}
            emphasize
          />
          <Kpi
            label="Cumulative margin"
            value={formatEUR(data.cumulative_margin)}
            emphasize
            tone={cumMarginTone}
          />
          <Kpi
            label="Cumulative margin %"
            value={formatPercent(data.cumulative_margin_pct)}
            emphasize
            tone={cumMarginTone}
          />
        </KpiGrid>
      </div>
      <FpBurdenedLifetime data={data} />
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          This month{" "}
          <span
            className="ml-1 inline-flex items-center text-muted-foreground/70"
            title="Per-month recognized margin is volatile: cost accrues continuously from allocations × salary, but tracked hours are often logged in bursts (end of month, after vacation, after the budget cap). A negative current-month margin does NOT mean the project is unprofitable — read the lifetime row above for the real answer."
          >
            ⓘ
          </span>
        </div>
        <KpiGrid cols={3}>
          <Kpi
            label="Recognized this month"
            value={formatEUR(data.recognized_revenue)}
          />
          <Kpi
            label="Recognized margin"
            value={formatEUR(data.recognized_margin)}
            tone={recMarginTone}
          />
          <Kpi
            label="Recognized margin %"
            value={formatPercent(data.recognized_margin_pct)}
            tone={recMarginTone}
          />
        </KpiGrid>
      </div>
    </div>
  );
}

function FpBurdenedLifetime({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  if (data.cumulative_burdened_cost == null) return null;
  const direct = data.cumulative_cost ? Number(data.cumulative_cost) : null;
  const burdened = Number(data.cumulative_burdened_cost);
  const burdenedMargin =
    data.cumulative_burdened_margin != null
      ? Number(data.cumulative_burdened_margin)
      : null;
  const tone =
    burdenedMargin == null
      ? null
      : burdenedMargin >= 0
        ? "positive"
        : "negative";
  // Highlight gap between direct and burdened: > 5% means bench drag is
  // material, > 50% means it dominates.
  const ratio = direct && direct > 0 ? burdened / direct : null;
  const gapNote =
    ratio == null
      ? null
      : ratio > 1.5
        ? `Burdened is ${ratio.toFixed(1)}× direct — heavy bench drag absorbed from the consultants working here.`
        : ratio > 1.05
          ? `Burdened is ${((ratio - 1) * 100).toFixed(0)}% above direct — some bench drag.`
          : "Burdened ≈ direct — the consultants here were near fully utilized.";

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Lifetime (fully-loaded)
        <span
          className="inline-flex items-center text-muted-foreground/70 normal-case tracking-normal"
          title={
            "Burdened cost replaces direct cost with each consultant's full salary " +
            "share for the months they were on this project. Bench drag they incurred " +
            "while assigned here is absorbed onto this project. A negative burdened " +
            "margin while direct margin is positive means the project priced its " +
            "billable time well, but the firm carried bench drag from the people we " +
            "put on it."
          }
        >
          ⓘ
        </span>
      </div>
      <KpiGrid>
        <Kpi
          label="Cumulative burdened cost"
          value={formatEUR(data.cumulative_burdened_cost)}
        />
        <Kpi
          label="Burdened margin"
          value={formatEUR(data.cumulative_burdened_margin)}
          tone={tone}
        />
        <Kpi
          label="Burdened margin %"
          value={formatPercent(data.cumulative_burdened_margin_pct)}
          tone={tone}
        />
        {gapNote && (
          <div className="text-xs leading-snug text-muted-foreground">
            {gapNote}
          </div>
        )}
      </KpiGrid>
    </div>
  );
}

function FpProgressBar({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  if (data.pct_complete == null) return null;
  const pct = Number(data.pct_complete);
  const capped = Math.min(1, Math.max(0, pct));
  const pctLabel = `${(pct * 100).toFixed(1)}%`;
  const overFill = pct > 1 ? Math.min(1, pct - 1) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Progress</span>
        <span className="tabular-nums">
          {pctLabel}
          {pct > 1 && (
            <span className="ml-1 font-medium text-red-700">over</span>
          )}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct > 1 ? "bg-emerald-700" : "bg-emerald-500",
          )}
          style={{ width: `${capped * 100}%` }}
        />
        {overFill > 0 && (
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-red-500/70"
            style={{ width: `${overFill * 100}%` }}
            title={`${((pct - 1) * 100).toFixed(0)}% over budget`}
          />
        )}
      </div>
    </div>
  );
}

function UnassignedTrackedTable({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const rows = data.unassigned_tracked ?? [];
  if (rows.length === 0) return null;
  const isTm = data.billing_model === "time_and_material";
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-medium">Logged time without assignment</h4>
        <span className="text-xs text-muted-foreground">
          revenue derived from each consultant&apos;s role_tier × project rate
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Consultant</th>
              <th className="px-3 py-2 text-left font-medium">Tier</th>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-right font-medium">Days</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              {isTm && (
                <>
                  <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2 text-right font-medium">Margin</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r, i) => {
              const margin = r.margin ? Number(r.margin) : null;
              const rev = r.revenue ? Number(r.revenue) : 0;
              const hasRate = rev > 0;
              return (
                <tr key={r.employee_id ?? `row-${i}`} className="hover:bg-muted/20">
                  <td className="px-3 py-2">{r.who_name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.role_tier ? (
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {r.role_tier}
                      </span>
                    ) : (
                      <span
                        className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800"
                        title="No role_tier set on this employee — revenue can't resolve"
                      >
                        no tier
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.sources.map((s) => (
                      <span
                        key={s}
                        className="mr-1 inline-flex items-center rounded bg-muted px-1.5 py-0.5"
                      >
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.tracked_hours}h
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {Number(r.tracked_days).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(r.cost)}
                  </td>
                  {isTm && (
                    <>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          !hasRate && "text-muted-foreground",
                        )}
                      >
                        {formatEUR(r.revenue)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right tabular-nums",
                          margin !== null && hasRate &&
                            (margin >= 0 ? "text-emerald-700" : "text-red-700"),
                        )}
                      >
                        {formatEUR(r.margin)}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Revenue uses the same project_rate → framework_rate chain as
        assignments, with the consultant&apos;s role_tier as the profile.
        Missing tier or missing rate → revenue silently zero (folded into the
        rate-gap banner above).
      </p>
    </div>
  );
}

function TrackedCell({
  trackedDays,
  trackedHours,
  billableDays,
  isFreelancer,
  enteredHours,
  enteredHoursSource,
}: {
  trackedDays: string | null | undefined;
  trackedHours: string | null | undefined;
  billableDays: number;
  isFreelancer: boolean;
  enteredHours: string | null | undefined;
  enteredHoursSource: "manual" | "awork" | null | undefined;
}) {
  if (isFreelancer) {
    if (enteredHours == null) {
      return (
        <td
          className="px-3 py-2 text-right tabular-nums text-muted-foreground"
          title="No freelancer hours logged for this month. Edit in the Freelancer hours card above."
        >
          —
        </td>
      );
    }
    // Display in days to match the employee rows (column unit is days);
    // hours live in the tooltip for operators who need the precision.
    // Source pill tags awork-sourced rows.
    const hoursNum = Number(enteredHours);
    const daysApprox = hoursNum / 8;
    return (
      <td
        className="px-3 py-2 text-right tabular-nums"
        title={`${hoursNum.toFixed(2)}h logged${enteredHoursSource === "awork" ? " (auto-filled from awork sync — edit to override)" : ""}`}
      >
        <span className="inline-flex items-center gap-1">
          <span>{daysApprox.toFixed(2)}</span>
          {enteredHoursSource === "awork" && (
            <span className="rounded bg-muted px-1 text-[8px] uppercase tracking-wider text-muted-foreground">
              awork
            </span>
          )}
        </span>
      </td>
    );
  }
  const days = trackedDays ? Number(trackedDays) : 0;
  // Variance: tracked vs billable. Green when reasonably close (±10%),
  // amber when significantly under, red when significantly over.
  const delta = days - billableDays;
  const ratio = billableDays > 0 ? days / billableDays : 0;
  let tone = "";
  if (billableDays === 0 && days === 0) {
    tone = "text-muted-foreground";
  } else if (ratio >= 0.9 && ratio <= 1.1) {
    tone = "text-emerald-700";
  } else if (ratio < 0.9) {
    tone = "text-amber-700";
  } else {
    tone = "text-red-700";
  }
  return (
    <td
      className={cn("px-3 py-2 text-right tabular-nums", tone)}
      title={`${trackedHours ?? 0}h logged · ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}d vs billable`}
    >
      {days.toFixed(2)}
    </td>
  );
}

function RateGapBanner({ days }: { days: number }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-medium">
          {days} billable day{days === 1 ? "" : "s"} without an effective rate
        </div>
        <div className="text-amber-800">
          Revenue contribution for those days is zero. Most common cause: the
          project rate row exists but its <code>valid_from</code> is later
          than the assignment&apos;s start. Edit the rate above (or add a
          second rate row covering the earlier period) to fix.
        </div>
      </div>
    </div>
  );
}

function AssignmentTable({
  data,
  mode,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
  mode: "tm" | "fp";
}) {
  if (data.assignments.length === 0) {
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
            <th className="px-3 py-2 text-left font-medium">Consultant</th>
            <th className="px-3 py-2 text-left font-medium">Profile</th>
            <th className="px-3 py-2 text-right font-medium">Alloc</th>
            <th className="px-3 py-2 text-right font-medium">FTE</th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Active working days × allocation. FTE multiplier is applied to revenue separately."
            >
              Days
            </th>
            <th className="px-3 py-2 text-right font-medium">Absent</th>
            <th className="px-3 py-2 text-right font-medium">Billable</th>
            {(data.has_personio_mapping || data.has_freelancer_hours) && (
              <th
                className="px-3 py-2 text-right font-medium"
                title="Employees: days logged in Personio (hours / 8). Freelancers: hours from the Freelancer hours card."
              >
                Tracked
              </th>
            )}
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            {mode === "fp" && (
              <th
                className="px-3 py-2 text-right font-medium"
                title="Burdened cost: full monthly salary distributed by share of total allocation across this consultant's projects. Higher than Cost when the consultant has bench drag this month; equal when fully utilized."
              >
                Burdened
              </th>
            )}
            {mode === "tm" && (
              <>
                <th className="px-3 py-2 text-right font-medium">Revenue</th>
                <th className="px-3 py-2 text-right font-medium">Margin</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.assignments.map((a) => {
            const margin = a.margin ? Number(a.margin) : null;
            const direct = Number(a.cost);
            const burdened = Number(a.burdened_cost);
            const burdenDelta =
              direct > 0 ? (burdened - direct) / direct : 0;
            return (
              <tr key={a.assignment_id} className="hover:bg-muted/20">
                <td className="px-3 py-2">
                  {a.who_name ?? "—"}
                  {a.rate_unresolved_days > 0 && (
                    <span
                      title={`${a.rate_unresolved_days} billable day(s) without a resolved rate — revenue silently zero. Check the project rate's valid_from for "${a.profile ?? ""}".`}
                      className="ml-2 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {a.rate_unresolved_days}d no rate
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {a.profile ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Number(a.allocation_pct).toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {a.fte ? Number(a.fte).toFixed(2) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {a.active_working_days}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                  title={
                    a.unpaid_absence_days > 0
                      ? `${a.unpaid_absence_days} of ${a.absence_days} day(s) were unpaid leave (Elternzeit / Unbezahlter Urlaub) — excluded from the cost numerator.`
                      : undefined
                  }
                >
                  {a.absence_days}
                  {a.unpaid_absence_days > 0 && (
                    <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-800">
                      {a.unpaid_absence_days}d unpaid
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {a.billable_days}
                </td>
                {(data.has_personio_mapping || data.has_freelancer_hours) && (
                  <TrackedCell
                    trackedDays={a.tracked_days}
                    trackedHours={a.tracked_hours}
                    billableDays={a.billable_days}
                    isFreelancer={a.kind === "freelancer"}
                    enteredHours={a.entered_hours}
                    enteredHoursSource={a.entered_hours_source}
                  />
                )}
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatEUR(a.cost)}
                </td>
                {mode === "fp" && (
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      burdenDelta > 0.05 && "text-amber-700",
                      burdenDelta < -0.05 && "text-muted-foreground",
                    )}
                    title={
                      burdenDelta > 0.05
                        ? `Burdened ${(burdenDelta * 100).toFixed(0)}% above direct cost — bench drag is being absorbed by this project.`
                        : burdenDelta < -0.05
                          ? `Burdened ${(burdenDelta * 100).toFixed(0)}% below direct cost — consultant is overbooked, salary spread thinner here.`
                          : "Burdened ≈ direct — consultant is roughly fully utilized."
                    }
                  >
                    {formatEUR(a.burdened_cost)}
                  </td>
                )}
                {mode === "tm" && (
                  <>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEUR(a.revenue)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums",
                        margin !== null &&
                          (margin >= 0 ? "text-emerald-700" : "text-red-700"),
                      )}
                    >
                      {formatEUR(a.margin)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
