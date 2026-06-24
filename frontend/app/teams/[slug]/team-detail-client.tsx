"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { TeamForecastSection } from "@/components/team/team-forecast-section";
import { TeamMonthlyPLChart } from "@/components/team/team-monthly-pl-chart";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type TeamMonthKpis,
  type TeamMonthProjectMixRow,
  type TeamMonthResponse,
  type TeamMonthRosterRow,
  useTeamMonth,
} from "@/lib/api/team-series";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { cn } from "@/lib/utils";

/** Client half of the team detail page. Server pre-computes `team_name`
 * + the forecast-section's "upcoming" list (anchored at now) and hands
 * them down as props. The selected month for the per-month detail
 * block lives here and drives a TanStack fetch against
 * `/api/teams/[slug]/month`. The chart fetches its own trailing-window
 * series — anchored at now and not affected by the selector. */
export function TeamDetailClient({
  slug,
  team_name,
  n_members_initial,
  upcoming,
  today,
  forecast_end,
  partial_drop_threshold_pct,
}: {
  slug: string;
  team_name: string;
  n_members_initial: number;
  upcoming: Parameters<typeof TeamForecastSection>[0]["upcoming"];
  today: string;
  forecast_end: string;
  partial_drop_threshold_pct: number;
}) {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);
  const { data, isLoading, isError, error } = useTeamMonth(slug, month);
  const isFuture = month > todayMonth;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/teams"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Teams
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {team_name}
        </h1>
        <div className="mt-1 text-sm text-muted-foreground">
          {n_members_initial}{" "}
          {n_members_initial === 1 ? "employee" : "employees"}
        </div>
      </div>

      {/* Selected-month detail card */}
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {monthLabel(month)}
              {isFuture && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (forecast)
                </span>
              )}
            </CardTitle>
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
              <KpiBlock kpis={data.kpis} />
              <RosterBlock
                roster={data.roster}
                show_now_signals={data.is_current_month}
              />
              <ProjectMixBlock mix={data.project_mix} />
            </>
          )}
        </CardContent>
      </Card>

      {/* Monthly P&L chart (history + current + forecast) */}
      <TeamMonthlyPLChart slug={slug} />

      {/* Forecast: ending soon + going partial — anchored at now */}
      <TeamForecastSection
        upcoming={upcoming}
        today={today}
        forecastEnd={forecast_end}
        partialThresholdPct={partial_drop_threshold_pct}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI block
// ---------------------------------------------------------------------------

function KpiBlock({ kpis }: { kpis: TeamMonthKpis }) {
  const totalMargin = Number(kpis.margin);
  const totalCost = Number(kpis.cost);
  const marginPct = kpis.margin_pct === null ? null : Number(kpis.margin_pct);
  const avgUtil =
    kpis.avg_util_pct === null ? null : Number(kpis.avg_util_pct);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
        <Kpi label="Revenue" value={formatEUR(kpis.revenue)} />
        <Kpi label="Cost" value={formatEUR(kpis.cost)} />
        <Kpi
          label="Margin"
          value={formatEUR(kpis.margin)}
          tone={
            totalMargin < 0
              ? "text-red-700"
              : totalMargin < totalCost * 0.1
                ? "text-amber-700"
                : "text-emerald-700"
          }
        />
        <Kpi
          label="Margin %"
          value={marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
          tone={
            marginPct === null
              ? undefined
              : marginPct < 0
                ? "text-red-700"
                : marginPct < 10
                  ? "text-amber-700"
                  : "text-emerald-700"
          }
        />
        <Kpi
          label="Utilization"
          value={avgUtil === null ? "—" : `${(avgUtil * 100).toFixed(0)}%`}
          tone={
            avgUtil === null
              ? undefined
              : avgUtil < 0.75
                ? "text-amber-700"
                : "text-emerald-700"
          }
        />
      </div>
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
        <Kpi label="Bench EUR" value={formatEUR(kpis.bench_eur)} />
        <Kpi
          label="Bench heads"
          value={
            <>
              {kpis.n_full_bench}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                fully · {kpis.n_partial_bench} partial
              </span>
            </>
          }
        />
        <Kpi
          label="Fully utilized"
          value={
            <>
              {kpis.n_fully_utilized}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                consultants
              </span>
            </>
          }
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-base font-semibold tabular-nums", tone)}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster block
// ---------------------------------------------------------------------------

function RosterBlock({
  roster,
  show_now_signals,
}: {
  roster: TeamMonthRosterRow[];
  /** "Bench since N days" and "ends soon" are anchored at today and
   * only meaningful when viewing the current month. */
  show_now_signals: boolean;
}) {
  if (roster.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Roster
        </h3>
        <p className="text-sm text-muted-foreground">
          No active members on file for this month.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Roster
      </h3>
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-left font-medium">
                Current project
              </th>
              <th className="px-3 py-2 text-right font-medium">Util %</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {roster.map((r) => {
              const util = Number(r.utilization_pct);
              const margin = Number(r.monthly_margin);
              const utilTone =
                util === 0
                  ? "text-red-700"
                  : util < 1
                    ? "text-amber-700"
                    : "text-emerald-700";
              const marginTone =
                margin < 0 ? "text-red-700" : "text-emerald-700";
              return (
                <tr key={r.employee_id} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <Link
                      href={`/employees/${r.employee_id}`}
                      className="hover:underline"
                    >
                      {r.who_name}
                    </Link>
                    {show_now_signals && r.bench_since_days !== null && (
                      <span className="ml-2 text-xs text-amber-700">
                        (bench since {r.bench_since_days}d)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.role_tier ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.primary_assignment?.project_id !== null &&
                    r.primary_assignment?.project_id !== undefined ? (
                      <>
                        <Link
                          href={`/projects/${r.primary_assignment.project_id}`}
                          className="hover:underline"
                        >
                          {r.primary_assignment.project_name}
                        </Link>
                        {r.primary_assignment.allocation_pct && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {(
                              Number(r.primary_assignment.allocation_pct) * 100
                            ).toFixed(0)}
                            %
                          </span>
                        )}
                        {show_now_signals && r.ends_soon && (
                          <span className="ml-2 text-xs text-amber-700">
                            ↳ ends {r.ends_soon.date}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      utilTone,
                    )}
                  >
                    {(util * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(r.monthly_cost)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      marginTone,
                    )}
                  >
                    {margin >= 0 ? "+" : ""}
                    {formatEUR(r.monthly_margin)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Project mix block
// ---------------------------------------------------------------------------

function ProjectMixBlock({ mix }: { mix: TeamMonthProjectMixRow[] }) {
  if (mix.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Project mix
      </h3>
      <div className="space-y-2">
        <div className="flex items-center gap-3 border-b pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div className="min-w-0 flex-1">Project</div>
          <div className="hidden flex-1 sm:block" aria-hidden />
          <div className="w-12 text-right">% rev</div>
          <div className="w-24 text-right">Revenue</div>
        </div>
        {mix.map((p) => {
          const pct = Number(p.pct_of_revenue);
          return (
            <div
              key={p.project_id}
              className="flex items-center gap-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/projects/${p.project_id}`}
                  className="hover:underline"
                >
                  {p.project_name}
                </Link>
              </div>
              <div className="hidden flex-1 sm:block">
                <div className="relative h-2 overflow-hidden rounded bg-muted">
                  <div
                    className="absolute inset-y-0 left-0 bg-primary/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <div className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                {pct.toFixed(0)}%
              </div>
              <div className="w-24 text-right tabular-nums">
                {formatEUR(p.revenue)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
