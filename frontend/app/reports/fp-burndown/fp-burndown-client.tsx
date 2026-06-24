"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimeBudgetBar } from "@/components/project/time-budget-bar";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type FpBurndownMonth,
  type FpBurndownProject,
  useFpBurndownMonth,
} from "@/lib/api/fp-burndown";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { cn } from "@/lib/utils";

export function FpBurndownClient() {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);
  const { data, isLoading, isError, error } = useFpBurndownMonth(month);
  const isFuture = month > todayMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Fixed-price burn-down
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One row per FP project that was active in the selected month.
          Per-project numbers (tracked, remaining, planned future) are
          always as-of-today — the month picker only filters which
          projects appear, never the burn state. Status combines
          margin (cost vs recognized) and projected end position
          (tracked + planned future vs time budget).
        </p>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{monthLabel(month)}</CardTitle>
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
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.projects.length} project
              {data.projects.length === 1 ? "" : "s"} active in this month ·
              numbers as of {data.as_of_date}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading && <Skeleton className="h-40 w-full" />}
          {isError && (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load"}
            </p>
          )}
          {data && (
            <>
              <SummaryRow data={data} />
              {data.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active fixed-price projects.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.projects.map((p) => (
                    <ProjectRow key={p.project_id} p={p} />
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryRow({ data }: { data: FpBurndownMonth }) {
  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span>
          <span className="font-medium">{data.summary.n_active}</span>{" "}
          <span className="text-muted-foreground">active FP</span>
        </span>
        <span
          className={cn(data.summary.n_margin_negative > 0 && "text-red-700")}
        >
          <span className="font-medium">{data.summary.n_margin_negative}</span>{" "}
          <span className="text-muted-foreground">margin negative</span>
        </span>
        <span
          className={cn(data.summary.n_time_exhausted > 0 && "text-red-700")}
        >
          <span className="font-medium">{data.summary.n_time_exhausted}</span>{" "}
          <span className="text-muted-foreground">time exhausted</span>
        </span>
        <span className={cn(data.summary.n_at_risk > 0 && "text-amber-700")}>
          <span className="font-medium">{data.summary.n_at_risk}</span>{" "}
          <span className="text-muted-foreground">at risk</span>
        </span>
        <span className="text-muted-foreground">·</span>
        <span>
          <span className="font-medium tabular-nums">
            {formatEUR(data.summary.total_agreed)}
          </span>{" "}
          <span className="text-muted-foreground">agreed</span>
        </span>
        <span>
          <span className="font-medium tabular-nums">
            {formatEUR(data.summary.total_recognized)}
          </span>{" "}
          <span className="text-muted-foreground">recognized</span>
        </span>
        <span>
          <span className="font-medium tabular-nums">
            {formatEUR(data.summary.total_cost)}
          </span>{" "}
          <span className="text-muted-foreground">cost</span>
        </span>
      </div>
    </div>
  );
}

function ProjectRow({ p }: { p: FpBurndownProject }) {
  return (
    <li className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/projects/${p.project_id}`}
            className="hover:underline"
          >
            <span className="text-muted-foreground">{p.customer_name}</span>
            <span className="mx-1 text-muted-foreground">/</span>
            <span className="font-medium">{p.project_name}</span>
          </Link>
          <Badge variant="outline" className="ml-2">
            FP · {p.recognition_method.replace("_", " ")}
          </Badge>
        </div>
        <StatusBadge p={p} />
      </div>
      <BurnBar p={p} />
      <EurStrip p={p} />
    </li>
  );
}

function BurnBar({ p }: { p: FpBurndownProject }) {
  if (p.recognition_method === "tracked_hours" && p.time_budget_hours) {
    const tracked = Number(p.tracked_hours);
    const futurePlanned = Number(p.future_planned_hours ?? "0");
    const budget = p.time_budget_hours;
    const remainingHours = Math.max(budget - tracked, 0);
    const overrunHours =
      tracked + futurePlanned > budget
        ? tracked + futurePlanned - budget
        : 0;
    return (
      <div className="mt-3">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
          <span className="font-medium tabular-nums">
            {tracked.toFixed(0)}h tracked
            <span className="ml-1 text-muted-foreground">
              of {budget}h budget
            </span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">remaining </span>
            <span className="font-medium">{remainingHours.toFixed(0)}h</span>
          </span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">planned future </span>
            <span className="font-medium">{futurePlanned.toFixed(0)}h</span>
          </span>
          {overrunHours > 0 && (
            <span className="font-medium tabular-nums text-red-700">
              +{overrunHours.toFixed(0)}h over budget
            </span>
          )}
        </div>
        <TimeBudgetBar
          trackedHours={tracked}
          budgetHours={budget}
          futurePlannedHours={futurePlanned}
        />
      </div>
    );
  }

  if (p.recognition_method === "timeline" && p.elapsed_pct !== null) {
    const elapsed = Number(p.elapsed_pct);
    const fillTone =
      Number(p.margin_erosion_pct ?? "0") > 25
        ? "bg-red-500/70"
        : Number(p.margin_erosion_pct ?? "0") > 10
          ? "bg-amber-500/70"
          : "bg-emerald-500/70";
    return (
      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground tabular-nums">
            Timeline elapsed
          </span>
          <span className="font-medium tabular-nums">
            {(elapsed * 100).toFixed(0)}%
          </span>
        </div>
        <div className="relative h-3 overflow-hidden rounded bg-muted">
          <div
            className={cn("absolute inset-y-0 left-0", fillTone)}
            style={{ width: `${elapsed * 100}%` }}
          />
        </div>
      </div>
    );
  }

  // No rule — skip the bar entirely
  return null;
}

function EurStrip({ p }: { p: FpBurndownProject }) {
  const cost = Number(p.cumulative_cost);
  const recognized = Number(p.cumulative_recognized);
  const margin = recognized - cost;
  const marginTone =
    margin < 0
      ? "text-red-700"
      : margin < recognized * 0.1
        ? "text-amber-700"
        : "text-emerald-700";
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
      <span>
        <span className="text-muted-foreground">recognized </span>
        <span className="font-medium tabular-nums">
          {formatEUR(p.cumulative_recognized)}
        </span>
        {p.agreed_amount && (
          <span className="text-muted-foreground tabular-nums">
            {" "}
            of {formatEUR(p.agreed_amount)}
          </span>
        )}
      </span>
      <span>
        <span className="text-muted-foreground">cost </span>
        <span className="font-medium tabular-nums">
          {formatEUR(p.cumulative_cost)}
        </span>
      </span>
      <span>
        <span className="text-muted-foreground">margin </span>
        <span className={cn("font-medium tabular-nums", marginTone)}>
          {margin >= 0 ? "" : "−"}
          {formatEUR(Math.abs(margin).toFixed(2))}
        </span>
      </span>
      {p.planned_end_date && (
        <span className="text-muted-foreground tabular-nums">
          ends {p.planned_end_date}
          {p.days_to_end !== null && p.days_to_end > 0 && (
            <> · {p.days_to_end}d left</>
          )}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ p }: { p: FpBurndownProject }) {
  const labels: Record<FpBurndownProject["status"], string> = {
    margin_negative: "margin negative",
    time_exhausted: "time exhausted",
    at_risk: "at risk",
    on_track: "on track",
    not_started: "not started",
    ended: "ended",
    no_rule: "no recognition rule",
  };
  // Tone reflects severity, not just "warning ≠ ok". time_exhausted is
  // red because no more revenue is reachable on the contract — even if
  // the project still has positive EUR margin, that's a hard cap that
  // ought to read alarming. margin_negative is also red (and ranks
  // worse in the sort).
  const tones: Record<FpBurndownProject["status"], string> = {
    margin_negative: "bg-red-100 text-red-800",
    time_exhausted: "bg-red-100 text-red-800",
    at_risk: "bg-amber-100 text-amber-800",
    on_track: "bg-emerald-100 text-emerald-800",
    not_started: "bg-muted text-muted-foreground",
    ended: "bg-muted text-muted-foreground",
    no_rule: "bg-amber-50 text-amber-800",
  };
  const detail =
    p.recognition_method === "tracked_hours" && p.variance_pp !== null
      ? ` · Δ ${Number(p.variance_pp) >= 0 ? "+" : ""}${Number(p.variance_pp).toFixed(0)}pp`
      : p.recognition_method === "timeline" && p.margin_erosion_pct !== null
        ? ` · margin ${Number(p.margin_erosion_pct) >= 0 ? "−" : "+"}${Math.abs(Number(p.margin_erosion_pct)).toFixed(0)}pp`
        : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
        tones[p.status],
      )}
    >
      {labels[p.status]}
      {detail && <span className="font-normal opacity-80">{detail}</span>}
    </span>
  );
}
