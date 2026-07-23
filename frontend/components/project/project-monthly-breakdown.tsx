"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeBudgetBar } from "@/components/project/time-budget-bar";
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
  return (
    <div className="space-y-5">
      <TmStatusBanner data={data} />
      <TmMoneyBlock data={data} />
      <TmBudgetStrip data={data} />
      <TmLifetimeBlock data={data} />
      <TmEffortBlock data={data} />
      <AssignmentTable data={data} mode="tm" />
      <UnassignedTrackedTable data={data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// T&M budget — consumed (lifetime billable revenue) vs. the agreed budget.
// Only rendered when an agreed amount is set. "Consumed" is deliberately
// billable revenue (tracked hours × rate), NOT loaded cost, because the budget
// is agreed with the customer on the daily rate, not on our internal cost.
// ---------------------------------------------------------------------------

function TmBudgetStrip({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const agreed = data.agreed_amount_eur ? Number(data.agreed_amount_eur) : null;
  // Show only when a budget is provided on the project.
  if (agreed === null || agreed <= 0) return null;
  const consumed = Number(data.cumulative_revenue ?? "0");
  const remaining = agreed - consumed;
  const pct = (consumed / agreed) * 100;
  const over = consumed > agreed;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Budget
        </h3>
        <span className="text-xs text-muted-foreground">
          billable revenue vs. agreed amount
        </span>
      </div>
      <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="tabular-nums">
            <span className={cn("font-medium", over && "text-red-700")}>
              {formatEUR(consumed.toFixed(2))}
            </span>{" "}
            <span className="text-muted-foreground">consumed</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">of </span>
            <span className="font-medium">
              {formatEUR(agreed.toFixed(2))} budget
            </span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">
              {over ? "over by " : "remaining "}
            </span>
            <span className={cn("font-medium", over && "text-red-700")}>
              {formatEUR(Math.abs(remaining).toFixed(2))}
            </span>
          </span>
          <span className="tabular-nums">
            <span className="font-medium">{pct.toFixed(0)}%</span>{" "}
            <span className="text-muted-foreground">consumed</span>
          </span>
        </div>
        {/* Burn-down bar: consumed vs. the agreed budget (100% track). */}
        <div
          className={cn(
            "h-2.5 w-full overflow-hidden rounded-full bg-muted",
            over && "ring-1 ring-red-500",
          )}
        >
          <div
            className={cn(
              "h-full rounded-full",
              over ? "bg-red-500" : "bg-emerald-500",
            )}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Consumed = lifetime billable revenue (tracked hours × rate). The bar
          fills toward the agreed budget and turns red when consumption exceeds
          it.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// T&M lifetime (project-to-date) totals — sits under the monthly money box
// ---------------------------------------------------------------------------

function TmLifetimeBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const num = (v: string | null | undefined) =>
    v === null || v === undefined ? null : Number(v);
  const revenue = num(data.cumulative_revenue);
  const cost = num(data.cumulative_cost);
  const burdenedCost = num(data.cumulative_burdened_cost);
  const margin = num(data.cumulative_margin);
  const marginPct = num(data.cumulative_margin_pct);
  const burdenedMargin = num(data.cumulative_burdened_margin);
  const burdenedMarginPct = num(data.cumulative_burdened_margin_pct);
  const personDays = num(data.lifetime_tracked_person_days);
  const trackedHours = num(data.tracked_hours_lifetime);

  // Nothing to show until lifetime aggregates exist (e.g. brand-new
  // project with no cost yet).
  if (revenue === null && cost === null) return null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Lifetime (project to date)
        </h3>
        <span className="text-xs text-muted-foreground">
          all months combined · costs priced at current salaries
        </span>
      </div>
      <div className="rounded-md border bg-background">
        <div className="flex flex-wrap gap-x-8 gap-y-1 border-b bg-muted/20 px-4 py-2 text-sm">
          <div>
            <span className="text-muted-foreground">Billable revenue: </span>
            <span
              className="font-medium tabular-nums"
              title="Lifetime tracked hours × rate across all months (T&M)."
            >
              {revenue === null ? "—" : formatEUR(revenue.toFixed(2))}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Person-days tracked: </span>
            <span className="font-medium tabular-nums">
              {personDays === null ? "—" : personDays.toFixed(1)}
            </span>
            {trackedHours !== null && (
              <span className="text-xs text-muted-foreground">
                {" "}
                ({trackedHours.toFixed(0)}h)
              </span>
            )}
          </div>
        </div>
        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="space-y-2 p-4">
            <div className="flex items-baseline gap-1">
              <div className="text-sm font-medium">Project P&amp;L</div>
              <div className="text-xs text-muted-foreground">
                · allocated salary (no burden)
              </div>
            </div>
            <PLRow label="Cost total" value={cost} muted />
            <PLRow
              label="Margin total"
              value={margin}
              pct={marginPct}
              emphasize
            />
          </div>
          <div className="space-y-2 p-4">
            <div className="flex items-baseline gap-1">
              <div className="text-sm font-medium">True P&amp;L</div>
              <div className="text-xs text-muted-foreground">
                · burdened (real org cost)
              </div>
            </div>
            <PLRow label="Burdened cost total" value={burdenedCost} muted />
            <PLRow
              label="Margin total"
              value={burdenedMargin}
              pct={burdenedMarginPct}
              emphasize
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// T&M status banner — at-a-glance health
// ---------------------------------------------------------------------------

type TmStatus =
  | "on_track"
  | "rate_unresolved"
  | "margin_negative"
  | "staffed_no_tracking"
  | "no_data";

function deriveTmStatus(
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>,
): TmStatus {
  const tracked = Number(data.tracked_hours ?? "0");
  const cost = Number(data.cost ?? "0");
  const margin = data.margin ? Number(data.margin) : null;
  // Staffed-but-not-tracking is the case the engine fix surfaces:
  // someone is allocated (cost > 0) but nobody has logged time
  // (tracked = 0). Revenue is correctly zero — this used to read as
  // "no tracked time yet" with a healthy looking allocation-revenue
  // headline. Now it reads red.
  if (tracked === 0 && cost > 0) return "staffed_no_tracking";
  if (tracked === 0) return "no_data";
  if (margin !== null && margin < 0) return "margin_negative";
  if (data.rate_unresolved_days > 0) return "rate_unresolved";
  return "on_track";
}

const TM_STATUS_LABEL: Record<TmStatus, string> = {
  on_track: "On track",
  rate_unresolved: "Rate gap",
  margin_negative: "Margin negative",
  staffed_no_tracking: "Staffed, not tracking",
  no_data: "No activity",
};

const TM_STATUS_TONE: Record<TmStatus, string> = {
  on_track: "bg-emerald-100 text-emerald-800",
  rate_unresolved: "bg-amber-100 text-amber-800",
  margin_negative: "bg-red-100 text-red-800",
  staffed_no_tracking: "bg-red-100 text-red-800",
  no_data: "bg-muted text-muted-foreground",
};

function TmStatusBanner({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const status = deriveTmStatus(data);
  const marginPct =
    data.margin_pct !== null && data.margin_pct !== undefined
      ? Number(data.margin_pct)
      : null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-4 py-3 text-sm">
      <span
        className={cn(
          "rounded px-2 py-0.5 text-xs font-medium",
          TM_STATUS_TONE[status],
        )}
      >
        {TM_STATUS_LABEL[status]}
      </span>
      <span className="tabular-nums">
        <span className="text-muted-foreground">Revenue this month: </span>
        <span className="font-medium">{formatEUR(data.revenue ?? "0")}</span>
      </span>
      {marginPct !== null && (
        <span className="tabular-nums">
          <span className="text-muted-foreground">Margin: </span>
          <span
            className={cn(
              "font-medium",
              marginPct < 0
                ? "text-red-700"
                : marginPct < 10
                  ? "text-amber-700"
                  : "text-emerald-700",
            )}
          >
            {marginPct >= 0 ? "" : "−"}
            {Math.abs(marginPct).toFixed(1)}%
          </span>
        </span>
      )}
      {data.rate_unresolved_days > 0 && (
        <span
          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
          title="Days where an assignment had no project_rate or framework rate to resolve to — revenue couldn't be calculated for these days. Configure the role-tier rate to fix."
        >
          {data.rate_unresolved_days}d unresolved rate
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T&M Money block — dual P&L (Project + True)
// ---------------------------------------------------------------------------

function TmMoneyBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const revenue = data.revenue ? Number(data.revenue) : 0;
  const allocationRevenue = data.allocation_revenue
    ? Number(data.allocation_revenue)
    : null;
  // Under-tracking gap = what we committed to bill − what we actually
  // tracked. Surface it whenever it's materially larger than a rounding
  // glitch so SDMs see the missing billable hours instead of guessing.
  const undertrackedGap =
    allocationRevenue !== null && allocationRevenue - revenue > 1
      ? allocationRevenue - revenue
      : null;
  const allocatedCost = Number(data.cost);
  const allocatedMargin = revenue - allocatedCost;
  const allocatedMarginPct =
    revenue > 0 ? (allocatedMargin / revenue) * 100 : null;

  const burdenedCost = Number(data.burdened_cost);
  const burdenedMargin = revenue - burdenedCost;
  const burdenedMarginPct =
    revenue > 0 ? (burdenedMargin / revenue) * 100 : null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Money this month
        </h3>
        <span className="text-xs text-muted-foreground">
          billable revenue vs. cost
        </span>
      </div>
      <div className="rounded-md border bg-background">
        <div className="border-b bg-muted/20 px-4 py-2 text-sm">
          <div>
            <span className="text-muted-foreground">
              Billable revenue this month:{" "}
            </span>
            <span
              className="font-medium tabular-nums"
              title="Tracked hours × rate. This is what the customer is invoiced — allocation that wasn't tracked produces no revenue here."
            >
              {formatEUR(data.revenue ?? "0")}
            </span>
          </div>
          {undertrackedGap !== null && (
            <div
              className="mt-0.5 text-xs text-amber-700 tabular-nums"
              title="Allocation × rate × billable days. Going from allocation to billable requires the assigned consultants to log their hours."
            >
              Allocation projected{" "}
              {formatEUR(allocationRevenue!.toFixed(2))} ·{" "}
              <span className="font-medium">
                {formatEUR(undertrackedGap.toFixed(2))} not yet tracked
              </span>
            </div>
          )}
        </div>
        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <PLPanel
            title="Project P&L"
            subtitle="allocated salary (no burden)"
            costLabel="Cost"
            costValue={allocatedCost}
            marginNow={allocatedMargin}
            marginNowPct={allocatedMarginPct}
            marginProjected={null}
            marginProjectedPct={null}
            tooltip="Allocated salary cost: each consultant's salary share based on their assignment allocation to this project. Treats bench time as someone else's problem."
          />
          <PLPanel
            title="True P&L"
            subtitle="burdened (real org cost)"
            costLabel="Burdened cost"
            costValue={burdenedCost}
            marginNow={burdenedMargin}
            marginNowPct={burdenedMarginPct}
            marginProjected={null}
            marginProjectedPct={null}
            tooltip="Burdened cost: each consultant's full salary share for the months they were on this project. Bench drag they incurred while assigned here is absorbed onto this project."
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// T&M Effort & forward look
// ---------------------------------------------------------------------------

function TmEffortBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const trackedThisMonth = Number(data.tracked_hours ?? "0");
  const futurePlanned = Number(data.future_planned_hours ?? "0");
  const futurePlannedShown = futurePlanned > 0;
  const trackedRevenue = data.tracked_revenue
    ? Number(data.tracked_revenue)
    : null;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Effort &amp; forward look
        </h3>
        <span className="text-xs text-muted-foreground">
          delivered hours and what&rsquo;s committed next
        </span>
      </div>
      <div className="grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Tracked hours this month
          </div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">
            {trackedThisMonth.toFixed(0)}h
          </div>
          {trackedRevenue !== null && (
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              ≈ {formatEUR(trackedRevenue.toFixed(2))} at prevailing rates
            </div>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Planned future hours
          </div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">
            {futurePlannedShown ? `${futurePlanned.toFixed(0)}h` : "—"}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {data.planned_end_date
              ? `through planned end (${data.planned_end_date})`
              : "no planned end on file"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Rate-unresolved days
          </div>
          <div
            className={cn(
              "mt-0.5 text-base font-semibold tabular-nums",
              data.rate_unresolved_days > 0
                ? "text-amber-700"
                : "text-emerald-700",
            )}
          >
            {data.rate_unresolved_days}d
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {data.rate_unresolved_days > 0
              ? "days that didn't resolve to a billable rate"
              : "all days billed at a resolved rate"}
          </div>
        </div>
      </div>
    </section>
  );
}

function FpBreakdown({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  return (
    <div className="space-y-5">
      <FpStatusBanner data={data} />
      <FpTimeBudgetBlock data={data} />
      <FpMoneyBlock data={data} />
      <FpScheduleBlock data={data} />
      <FpAccountingDisclosure data={data} />
      <AssignmentTable data={data} mode="fp" />
      <UnassignedTrackedTable data={data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status banner — at-a-glance health summary
// ---------------------------------------------------------------------------

type FpStatus =
  | "on_track"
  | "at_risk"
  | "time_exhausted"
  | "margin_negative"
  | "no_rule";

function deriveFpStatus(
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>,
): FpStatus {
  if (!data.recognition_method || data.recognition_method === "none") {
    return "no_rule";
  }
  const recognized = Number(data.cumulative_recognized_revenue ?? "0");
  const cost = Number(data.cumulative_cost ?? "0");
  // Margin_negative now = projected end margin is negative (forward
  // looking). Mid-flight cumulative_margin lagging recognition isn't
  // a real-money loss signal — that's the trap the rework is fixing.
  const projectedMargin =
    data.projected_margin !== null && data.projected_margin !== undefined
      ? Number(data.projected_margin)
      : null;
  if (projectedMargin !== null && projectedMargin < 0) return "margin_negative";
  if (recognized > 0 && cost > recognized * 1.1 && projectedMargin === null) {
    // Fallback when projection isn't possible (no tracked hours yet)
    // and cost is already meaningfully above recognized.
    return "margin_negative";
  }
  if (data.over_budget) return "time_exhausted";
  const trackedH = Number(data.tracked_hours_lifetime ?? "0");
  const budgetH = data.time_budget_hours ?? null;
  if (budgetH && trackedH > 0) {
    const projectedTotal = trackedH + Number(data.future_planned_hours ?? "0");
    if (projectedTotal > budgetH * 1.1) return "at_risk";
  }
  return "on_track";
}

const STATUS_LABEL: Record<FpStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  time_exhausted: "Time exhausted",
  margin_negative: "Margin negative",
  no_rule: "No recognition rule",
};

const STATUS_TONE: Record<FpStatus, string> = {
  on_track: "bg-emerald-100 text-emerald-800",
  at_risk: "bg-amber-100 text-amber-800",
  time_exhausted: "bg-red-100 text-red-800",
  margin_negative: "bg-red-100 text-red-800",
  no_rule: "bg-amber-50 text-amber-800",
};

function FpStatusBanner({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const status = deriveFpStatus(data);
  const tracked = Number(data.tracked_hours_lifetime ?? "0");
  const budget = data.time_budget_hours ?? null;
  const trackedPct =
    budget && budget > 0 ? Math.min((tracked / budget) * 100, 999) : null;
  const projectedMarginPct =
    data.projected_margin_pct !== null && data.projected_margin_pct !== undefined
      ? Number(data.projected_margin_pct)
      : null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-4 py-3 text-sm">
      <span
        className={cn(
          "rounded px-2 py-0.5 text-xs font-medium",
          STATUS_TONE[status],
        )}
      >
        {STATUS_LABEL[status]}
      </span>
      {budget !== null && (
        <span className="tabular-nums">
          <span className="text-muted-foreground">Time: </span>
          <span className="font-medium">
            {tracked.toFixed(0)}h / {budget}h
          </span>
          {trackedPct !== null && (
            <span className="ml-1 text-muted-foreground">
              ({trackedPct.toFixed(0)}%)
            </span>
          )}
        </span>
      )}
      {projectedMarginPct !== null && (
        <span className="tabular-nums">
          <span className="text-muted-foreground">Projected margin: </span>
          <span
            className={cn(
              "font-medium",
              projectedMarginPct < 0
                ? "text-red-700"
                : projectedMarginPct < 10
                  ? "text-amber-700"
                  : "text-emerald-700",
            )}
          >
            {projectedMarginPct >= 0 ? "" : "−"}
            {Math.abs(projectedMarginPct).toFixed(1)}%
          </span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time budget — burn-down bar with tracked + planned future segments
// ---------------------------------------------------------------------------

function FpTimeBudgetBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const budget = data.time_budget_hours ?? null;
  if (!budget || budget <= 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Time budget
        </h3>
        <p className="text-sm text-muted-foreground">
          No time budget set. Configure <code>time_budget_hours</code> on the
          project to enable the burn-down view.
        </p>
      </section>
    );
  }
  const tracked = Number(data.tracked_hours_lifetime ?? "0");
  const planned = Number(data.future_planned_hours ?? "0");
  const remaining = Math.max(budget - tracked, 0);
  const overrun =
    tracked + planned > budget ? tracked + planned - budget : 0;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Time budget
        </h3>
        <span className="text-xs text-muted-foreground">
          how much delivery effort is left
        </span>
      </div>
      <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="font-medium tabular-nums">
            {tracked.toFixed(0)}h{" "}
            <span className="font-normal text-muted-foreground">tracked</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">of </span>
            <span className="font-medium">{budget}h budget</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">remaining </span>
            <span className="font-medium">{remaining.toFixed(0)}h</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">planned ahead </span>
            <span className="font-medium">{planned.toFixed(0)}h</span>
          </span>
          {overrun > 0 && (
            <span className="font-medium tabular-nums text-red-700">
              +{overrun.toFixed(0)}h over budget
            </span>
          )}
        </div>
        <TimeBudgetBar
          trackedHours={tracked}
          budgetHours={budget}
          futurePlannedHours={planned}
        />
        <p className="text-xs text-muted-foreground">
          Solid bar = hours already tracked. Lighter extension = hours
          committed to future assignments. Gap to the right = unplanned
          remaining budget. The tick at the right edge marks the
          contracted cap.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Money — Project P&L (allocated) + True P&L (burdened) side by side
// ---------------------------------------------------------------------------

function FpMoneyBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  const agreed = data.agreed_amount_eur
    ? Number(data.agreed_amount_eur)
    : null;
  const allocatedCost = Number(data.cumulative_cost ?? "0");
  const allocatedMargin = agreed === null ? null : agreed - allocatedCost;
  const allocatedMarginPct =
    agreed !== null && agreed > 0 && allocatedMargin !== null
      ? (allocatedMargin / agreed) * 100
      : null;

  const burdenedCost = data.cumulative_burdened_cost
    ? Number(data.cumulative_burdened_cost)
    : null;
  const burdenedMargin =
    agreed === null || burdenedCost === null ? null : agreed - burdenedCost;
  const burdenedMarginPct =
    agreed !== null && agreed > 0 && burdenedMargin !== null
      ? (burdenedMargin / agreed) * 100
      : null;

  const projectedMargin =
    data.projected_margin !== null && data.projected_margin !== undefined
      ? Number(data.projected_margin)
      : null;
  const projectedMarginPct =
    data.projected_margin_pct !== null &&
    data.projected_margin_pct !== undefined
      ? Number(data.projected_margin_pct)
      : null;
  const projectedBurdenedMargin =
    data.projected_burdened_margin !== null &&
    data.projected_burdened_margin !== undefined
      ? Number(data.projected_burdened_margin)
      : null;
  const projectedBurdenedMarginPct =
    data.projected_burdened_margin_pct !== null &&
    data.projected_burdened_margin_pct !== undefined
      ? Number(data.projected_burdened_margin_pct)
      : null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Money: do we make money on this project?
        </h3>
        <span className="text-xs text-muted-foreground">
          forward-looking projections in <span className="italic">italic</span>
        </span>
      </div>
      <div className="rounded-md border bg-background">
        <div className="border-b bg-muted/20 px-4 py-2 text-sm">
          <span className="text-muted-foreground">Contracted price: </span>
          <span className="font-medium tabular-nums">
            {agreed === null ? "—" : formatEUR(agreed.toFixed(2))}
          </span>
        </div>
        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <PLPanel
            title="Project P&L"
            subtitle="allocated salary (no burden)"
            costLabel="Cost so far"
            costValue={allocatedCost}
            marginNow={allocatedMargin}
            marginNowPct={allocatedMarginPct}
            marginProjected={projectedMargin}
            marginProjectedPct={projectedMarginPct}
            tooltip="Allocated salary cost: each consultant's salary share based on their assignment allocation to this project. Treats bench time as someone else's problem."
          />
          <PLPanel
            title="True P&L"
            subtitle="burdened (real org cost)"
            costLabel="Burdened cost so far"
            costValue={burdenedCost}
            marginNow={burdenedMargin}
            marginNowPct={burdenedMarginPct}
            marginProjected={projectedBurdenedMargin}
            marginProjectedPct={projectedBurdenedMarginPct}
            tooltip="Burdened cost: each consultant's full salary share for the months they were on this project. Bench drag they incurred while assigned here is absorbed onto this project. Reflects what the firm actually spent."
          />
        </div>
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Lifetime costs are priced at <em>current</em> salaries (historical
          months are approximated, not as-of). Recognized revenue derives live
          from the current agreed amount, time budget, and planned dates —
          editing those restates past months.
        </p>
      </div>
    </section>
  );
}

function PLPanel({
  title,
  subtitle,
  costLabel,
  costValue,
  marginNow,
  marginNowPct,
  marginProjected,
  marginProjectedPct,
  tooltip,
}: {
  title: string;
  subtitle: string;
  costLabel: string;
  costValue: number | null;
  marginNow: number | null;
  marginNowPct: number | null;
  marginProjected: number | null;
  marginProjectedPct: number | null;
  tooltip: string;
}) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-baseline gap-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">· {subtitle}</div>
        <span
          className="ml-auto cursor-help text-xs text-muted-foreground/70"
          title={tooltip}
        >
          ⓘ
        </span>
      </div>
      <PLRow
        label={costLabel}
        value={costValue}
        muted
      />
      <PLRow label="Margin so far" value={marginNow} pct={marginNowPct} />
      <PLRow
        label="Projected end margin"
        value={marginProjected}
        pct={marginProjectedPct}
        italic
        emphasize
      />
    </div>
  );
}

function PLRow({
  label,
  value,
  pct,
  muted,
  italic,
  emphasize,
}: {
  label: string;
  value: number | null;
  pct?: number | null;
  muted?: boolean;
  italic?: boolean;
  emphasize?: boolean;
}) {
  const tone =
    value === null
      ? ""
      : value < 0
        ? "text-red-700"
        : value < (Math.abs(value) * 0.0001) // dummy never-true; keep neutral when positive
          ? ""
          : "";
  const moneyTone =
    value === null ? "" : value < 0 ? "text-red-700" : "text-emerald-700";
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-2 text-sm",
        italic && "italic",
        muted && "text-muted-foreground",
      )}
    >
      <span className={cn(emphasize && "font-medium")}>{label}</span>
      <span className="tabular-nums">
        <span
          className={cn(
            emphasize && "font-medium",
            !muted && moneyTone,
            !muted && tone,
          )}
        >
          {value === null
            ? "—"
            : `${value < 0 ? "−" : ""}${formatEUR(Math.abs(value).toFixed(2))}`}
        </span>
        {pct !== undefined && pct !== null && (
          <span
            className={cn(
              "ml-1 text-xs",
              !muted && (pct < 0 ? "text-red-700" : "text-muted-foreground"),
            )}
          >
            ({pct >= 0 ? "" : "−"}
            {Math.abs(pct).toFixed(1)}%)
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule — planned dates + elapsed share
// ---------------------------------------------------------------------------

function FpScheduleBlock({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  if (!data.planned_start_date || !data.planned_end_date) {
    return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const start = data.planned_start_date;
  const end = data.planned_end_date;
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const totalDays = Math.max(
    Math.round((endMs - startMs) / 86_400_000),
    1,
  );
  const elapsed = Math.max(
    0,
    Math.min(
      Math.round((todayMs - startMs) / 86_400_000),
      totalDays,
    ),
  );
  const elapsedPct = (elapsed / totalDays) * 100;
  const daysLeft = Math.max(
    Math.round((endMs - todayMs) / 86_400_000),
    0,
  );
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Schedule
        </h3>
        <span className="text-xs text-muted-foreground">
          where on the timeline are we?
        </span>
      </div>
      <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="tabular-nums">
            <span className="text-muted-foreground">Planned: </span>
            <span className="font-medium">
              {start} → {end}
            </span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">Elapsed: </span>
            <span className="font-medium">{elapsedPct.toFixed(0)}%</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">
              {todayMs > endMs ? "Ended " : "Days remaining: "}
            </span>
            <span className="font-medium">
              {todayMs > endMs
                ? Math.round((todayMs - endMs) / 86_400_000) + "d ago"
                : daysLeft + "d"}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Accounting recognition disclosure — finance-only detail
// ---------------------------------------------------------------------------

function FpAccountingDisclosure({
  data,
}: {
  data: NonNullable<ReturnType<typeof useProjectMonthly>["data"]>;
}) {
  if (
    !data.recognition_method ||
    data.recognition_method === "none" ||
    !data.cumulative_recognized_revenue
  ) {
    return null;
  }
  const method = data.recognition_method;
  const methodLabel =
    method === "tracked_hours"
      ? "tracked hours vs. time budget"
      : "linear over planned window";
  const cumRecognized = data.cumulative_recognized_revenue
    ? Number(data.cumulative_recognized_revenue)
    : null;
  const cumMargin = data.cumulative_margin
    ? Number(data.cumulative_margin)
    : null;
  const cumBurdenedMargin = data.cumulative_burdened_margin
    ? Number(data.cumulative_burdened_margin)
    : null;

  return (
    <section>
      <details className="group rounded-md border bg-background p-3">
        <summary className="flex cursor-pointer items-baseline gap-2 text-sm">
          <span className="font-medium">Accounting recognition</span>
          <span className="text-xs text-muted-foreground">
            (for finance — separate from the SDM steering view above)
          </span>
          <span className="ml-auto text-xs text-muted-foreground group-open:hidden">
            ▸
          </span>
          <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">
            ▾
          </span>
        </summary>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Recognition method: <span className="font-medium">{methodLabel}</span>
            . Recognized revenue is the share of the agreed amount that the
            accounting model says we&rsquo;ve <em>earned</em> so far —
            ramps up gradually instead of being booked upfront.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <PLRow
              label="Cumulative recognized"
              value={cumRecognized}
              muted
            />
            <PLRow
              label="Cumulative margin (recognized − allocated cost)"
              value={cumMargin}
            />
            <PLRow
              label="Cumulative margin (recognized − burdened cost)"
              value={cumBurdenedMargin}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>When does negative cumulative margin actually
            matter?</strong> Only when tracked hours have reached the time
            budget — recognition is then capped at the agreed amount, so
            further cost is pure loss. While tracked is still climbing
            toward the budget, a negative cumulative margin is just
            recognition lag (cost accrues continuously, recognition
            catches up at end). For the real &ldquo;is this project
            profitable?&rdquo; read, use <span className="font-medium">
              Money: do we make money on this project?
            </span>{" "}
            above.
          </p>
        </div>
      </details>
    </section>
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
  // Variance: tracked vs billable. Both sides are FTE-aware now —
  // `billableDays` is the calendar working days × FTE day-equivalents
  // (an 88% consultant on the project for 21 days gets 18.48 here),
  // and `trackedDays` is `tracked_hours / 8` from Personio attendance
  // (which is also FTE-proportional since lower-FTE people log fewer
  // hours per day). Same scale on both sides → meaningful ratio.
  // Green ±10%, amber significantly under, red significantly over.
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
                <td
                  className="px-3 py-2 text-right tabular-nums"
                  title={
                    a.kind === "employee" && a.fte && Number(a.fte) < 1
                      ? `${a.active_working_days} calendar working day(s) on this project × ${Number(a.fte).toFixed(2)} FTE`
                      : undefined
                  }
                >
                  {a.billable_days.toFixed(1)}
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
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      title={
                        a.allocation_revenue &&
                        Number(a.allocation_revenue) -
                          (a.revenue ? Number(a.revenue) : 0) >
                          1
                          ? `Tracked revenue ${formatEUR(a.revenue ?? "0")} · allocation projected ${formatEUR(a.allocation_revenue)} — ${formatEUR((Number(a.allocation_revenue) - (a.revenue ? Number(a.revenue) : 0)).toFixed(2))} not yet tracked.`
                          : "Tracked hours × rate (what the customer is invoiced)."
                      }
                    >
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
