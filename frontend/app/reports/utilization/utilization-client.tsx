"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { UtilizationSparkline } from "@/components/utilization/utilization-sparkline";
import { UtilizationTrendChart } from "@/components/utilization/utilization-trend-chart";
import {
  type BillableUtilGroup,
  type UtilizationGroupAggregate,
  type UtilizationMonthPoint,
  type UtilizationSeries,
  useUtilizationMonth,
  useUtilizationSeries,
} from "@/lib/api/utilization";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { teamSlug } from "@/lib/team-slug";
import { cn } from "@/lib/utils";

/** Client half of the utilization report. Owns selected-month state for
 * the per-month KPI / rollup / consultant blocks; the trend chart is
 * anchored at "now" and does not move with the month selector. */
export function UtilizationClient() {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);

  const seriesQuery = useUtilizationSeries(
    shiftMonth(todayMonth, -12),
    shiftMonth(todayMonth, +3),
  );
  const monthQuery = useUtilizationMonth(month);

  const selectedPoint = useMemo(
    () => seriesQuery.data?.points.find((p) => p.month === month) ?? null,
    [seriesQuery.data, month],
  );
  const isFuture = month > todayMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Booked capacity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How much of the people we&rsquo;re paying for is <em>booked</em> onto
          <strong> billable</strong> projects (assignment allocations vs. FTE —
          the commitment view, not tracked time). Allocations on non-billable /
          internal projects count as bench, not booked. Trailing 12 months plus
          3-month forecast on top; pick a month for the per-segment breakdown,
          benched and overbooked consultants below. For the selected month the
          tables also show the actuals side: <strong>Billable util %</strong>
          (tracked billable ÷ available) and <strong>Realized bench</strong>
          (cost of capacity that produced no billable output). Bench cost is
          booking-based — capacity we failed to allocate; the gap between the
          two EUR figures is unplanned billable work, i.e. allocation hygiene.
        </p>
      </div>

      <UtilizationTrendChart />

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
          {selectedPoint && (
            <p className="text-sm text-muted-foreground">
              {selectedPoint.totals.n_employees} eligible employees this month
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          <MonthKpis
            point={selectedPoint}
            loading={seriesQuery.isLoading}
            billableUtil={monthQuery.data?.billable_util?.totals ?? null}
          />
          <GroupRollup
            title="Per team"
            headerKey="Team"
            keyHref={(name) => `/teams/${teamSlug(name)}`}
            rows={selectedPoint?.by_team ?? []}
            series={seriesQuery.data}
            groupAxis="team"
            billableUtil={monthQuery.data?.billable_util?.by_team ?? null}
          />
          <GroupRollup
            title="Per role tier"
            headerKey="Role tier"
            rows={selectedPoint?.by_role_tier ?? []}
            series={seriesQuery.data}
            groupAxis="role_tier"
            billableUtil={monthQuery.data?.billable_util?.by_role_tier ?? null}
          />
          <BenchedList
            data={monthQuery.data?.benched ?? []}
            loading={monthQuery.isLoading}
          />
          <OverbookedList
            data={monthQuery.data?.overbooked ?? []}
            loading={monthQuery.isLoading}
          />
        </CardContent>
      </Card>

      <ForecastDriversSection series={seriesQuery.data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs (4 tiles)
// ---------------------------------------------------------------------------

function MonthKpis({
  point,
  loading,
  billableUtil,
}: {
  point: UtilizationMonthPoint | null;
  billableUtil: BillableUtilGroup | null;
  loading: boolean;
}) {
  if (loading && !point) {
    return <Skeleton className="h-20 w-full" />;
  }
  if (!point) {
    return (
      <p className="text-sm text-muted-foreground">
        No data for this month (outside the trailing window).
      </p>
    );
  }
  const eur = point.totals.util_pct_eur;
  const head = point.totals.util_pct_headcount;
  const eurTone =
    eur === null ? null : Number(eur) >= 80 ? "positive" : "negative";
  const headTone =
    head === null ? null : Number(head) >= 80 ? "positive" : "negative";
  const overbookTone =
    point.totals.n_overbook === 0 ? "positive" : "negative";
  return (
    <KpiGrid>
      <Kpi
        label="Booked % (€)"
        value={eur === null ? "—" : `${Number(eur).toFixed(1)}%`}
        tone={eurTone}
      />
      <Kpi
        label="Booked % (headcount)"
        value={head === null ? "—" : `${Number(head).toFixed(1)}%`}
        tone={headTone}
      />
      <Kpi
        label="Bench cost"
        value={formatEUR(point.totals.unallocated_cost)}
      />
      <Kpi
        label="Overbooked"
        value={`${point.totals.n_overbook}`}
        tone={overbookTone}
      />
      <Kpi
        label="Billable util (tracked)"
        value={
          billableUtil === null || billableUtil.billable_util_pct === null
            ? "—"
            : `${billableUtil.billable_util_pct.toFixed(1)}%`
        }
        sub={
          billableUtil === null
            ? "actuals — n/a for future months"
            : `${billableUtil.billable_h.toFixed(0)}h billable of ${billableUtil.available_h.toFixed(0)}h available`
        }
        tone={
          billableUtil === null || billableUtil.billable_util_pct === null
            ? null
            : billableUtil.billable_util_pct >= 70
              ? "positive"
              : "negative"
        }
      />
      <Kpi
        label="Realized bench cost"
        value={
          billableUtil?.realized_bench_cost === undefined ||
          billableUtil === null
            ? "—"
            : formatEUR(billableUtil.realized_bench_cost)
        }
        sub="capacity that produced no billable output — compare with Bench cost (unbooked capacity)"
      />
    </KpiGrid>
  );
}

// ---------------------------------------------------------------------------
// Per-team / per-role-tier rollup table with 12-month sparkline column
// ---------------------------------------------------------------------------

function GroupRollup({
  title,
  headerKey,
  rows,
  series,
  groupAxis,
  keyHref,
  billableUtil,
}: {
  title: string;
  headerKey: string;
  rows: UtilizationGroupAggregate[];
  series: UtilizationSeries | undefined;
  groupAxis: "team" | "role_tier";
  /** Optional href builder — used by per-team to deep-link to /teams/[slug]. */
  keyHref?: (key: string) => string;
  /** Realized billable utilization per group for the selected month
   * (tracked ÷ available); null while loading / for future months. */
  billableUtil?: BillableUtilGroup[] | null;
}) {
  const buByKey = useMemo(
    () => new Map((billableUtil ?? []).map((g) => [g.key, g])),
    [billableUtil],
  );
  const sparkData = useMemo(() => {
    if (!series) return new Map<string, Array<number | null>>();
    // Only actuals (not forecast) on the sparkline — keeps the drift
    // signal honest.
    const months = series.points.filter((p) => !p.is_forecast);
    const map = new Map<string, Array<number | null>>();
    for (const r of rows) {
      const arr: Array<number | null> = [];
      for (const p of months) {
        const group =
          groupAxis === "team"
            ? p.by_team.find((t) => t.key === r.key)
            : p.by_role_tier.find((t) => t.key === r.key);
        if (!group || group.util_pct_eur === null) {
          arr.push(null);
          continue;
        }
        // Show unallocated % — the "drift" most managers steer on.
        // = 100 - util_pct_eur
        arr.push(100 - Number(group.util_pct_eur));
      }
      map.set(r.key, arr);
    }
    return map;
  }, [rows, series, groupAxis]);

  if (rows.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">No data.</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{headerKey}</th>
              <th className="px-3 py-2 text-right font-medium">Headcount</th>
              <th className="px-3 py-2 text-right font-medium">Loaded cost</th>
              <th className="px-3 py-2 text-right font-medium">Booked % (€)</th>
              <th className="px-3 py-2 text-right font-medium">Booked % (HC)</th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Realized billable utilization for the selected month: tracked billable hours ÷ available hours (contract − absences). Actuals — compare against Booked % (the plan)."
              >
                Billable util %
              </th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Booking-based: loaded cost × unbooked share of FTE. The cost of capacity we failed to allocate — forward-manageable."
              >
                Bench cost
              </th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Realized: loaded cost × share of available hours with no billable output (tracked). What idle capacity actually cost — retrospective. Gap vs. Bench cost = unplanned billable work / allocation hygiene."
              >
                Realized bench
              </th>
              <th
                className="px-3 py-2 text-left font-medium"
                title="Bench % over the last 12 months"
              >
                Drift
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const eur =
                r.util_pct_eur === null ? null : Number(r.util_pct_eur);
              const head =
                r.util_pct_headcount === null
                  ? null
                  : Number(r.util_pct_headcount);
              const eurTone =
                eur === null
                  ? ""
                  : eur >= 80
                    ? "text-emerald-700"
                    : eur >= 60
                      ? "text-amber-700"
                      : "text-red-700";
              const headTone =
                head === null
                  ? ""
                  : head >= 80
                    ? "text-emerald-700"
                    : head >= 60
                      ? "text-amber-700"
                      : "text-red-700";
              const isReal = r.key !== "(no team)" && r.key !== "(unset)";
              return (
                <tr key={r.key} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    {keyHref && isReal ? (
                      <Link href={keyHref(r.key)} className="hover:underline">
                        {r.key}
                      </Link>
                    ) : (
                      r.key
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.n_employees}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(r.loaded_cost)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      eurTone,
                    )}
                  >
                    {eur === null ? "—" : `${eur.toFixed(0)}%`}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      headTone,
                    )}
                  >
                    {head === null ? "—" : `${head.toFixed(0)}%`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(() => {
                      const bu = buByKey.get(r.key);
                      return bu === undefined ||
                        bu.billable_util_pct === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `${bu.billable_util_pct.toFixed(0)}%`
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(r.unallocated_cost)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(() => {
                      const bu = buByKey.get(r.key);
                      return bu?.realized_bench_cost === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatEUR(bu.realized_bench_cost)
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    <UtilizationSparkline
                      values={sparkData.get(r.key) ?? []}
                    />
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
// Benched / overbooked consultant lists
// ---------------------------------------------------------------------------

function BenchedList({
  data,
  loading,
}: {
  data: NonNullable<ReturnType<typeof useUtilizationMonth>["data"]>["benched"];
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (data.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Currently benched
        </h3>
        <p className="text-sm text-muted-foreground">
          Nobody is fully or partially benched this month.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Currently benched · {data.length} consultant{data.length === 1 ? "" : "s"}
      </h3>
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Consultant</th>
              <th className="px-3 py-2 text-left font-medium">Team</th>
              <th className="px-3 py-2 text-left font-medium">Role tier</th>
              <th className="px-3 py-2 text-right font-medium">Loaded cost</th>
              <th className="px-3 py-2 text-right font-medium">Util %</th>
              <th className="px-3 py-2 text-right font-medium">Bench cost</th>
              <th className="px-3 py-2 text-left font-medium">Bench since</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.map((c) => {
              const u = Number(c.utilization_pct);
              const utilTone =
                u === 0
                  ? "text-red-700"
                  : u < 0.75
                    ? "text-amber-700"
                    : "text-emerald-700";
              const durTone =
                c.bench_since_days === null
                  ? "text-muted-foreground"
                  : c.bench_since_days >= 60
                    ? "text-red-700"
                    : c.bench_since_days >= 30
                      ? "text-amber-700"
                      : "text-muted-foreground";
              return (
                <tr key={c.employee_id} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <Link
                      href={`/employees/${c.employee_id}`}
                      className="hover:underline"
                    >
                      {c.who_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {c.team ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {c.role_tier ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(c.loaded_cost)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      utilTone,
                    )}
                  >
                    {(u * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(c.unallocated_cost)}
                  </td>
                  <td className={cn("px-3 py-2 text-xs", durTone)}>
                    {c.bench_since_days === null ? (
                      "—"
                    ) : (
                      <>
                        {c.bench_since_days}d
                        {c.bench_since_date && (
                          <span className="ml-1 text-muted-foreground">
                            (since {c.bench_since_date})
                          </span>
                        )}
                      </>
                    )}
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

function OverbookedList({
  data,
  loading,
}: {
  data: NonNullable<
    ReturnType<typeof useUtilizationMonth>["data"]
  >["overbooked"];
  loading: boolean;
}) {
  if (loading) return null;
  if (data.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Currently overbooked
        </h3>
        <p className="text-sm text-muted-foreground">
          Nobody is allocated above 100% this month.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Currently overbooked · {data.length} consultant
        {data.length === 1 ? "" : "s"}
      </h3>
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Consultant</th>
              <th className="px-3 py-2 text-left font-medium">Team</th>
              <th className="px-3 py-2 text-left font-medium">Role tier</th>
              <th className="px-3 py-2 text-right font-medium">Loaded cost</th>
              <th className="px-3 py-2 text-right font-medium">Util %</th>
              <th className="px-3 py-2 text-right font-medium">Overbook</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.map((c) => {
              const u = Number(c.utilization_pct);
              const overTone =
                Number(c.overbook_pct) >= 25
                  ? "text-red-700"
                  : "text-amber-700";
              return (
                <tr key={c.employee_id} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <Link
                      href={`/employees/${c.employee_id}`}
                      className="hover:underline"
                    >
                      {c.who_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {c.team ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {c.role_tier ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(c.loaded_cost)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-700">
                    {(u * 100).toFixed(0)}%
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      overTone,
                    )}
                  >
                    +{Number(c.overbook_pct).toFixed(0)}%
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
// Forecast drivers — projects ending + hires starting in the forecast window
// ---------------------------------------------------------------------------

function ForecastDriversSection({
  series,
}: {
  series: UtilizationSeries | undefined;
}) {
  if (!series) return null;
  const { forecast_drivers } = series;
  const { projects_ending, hires_starting } = forecast_drivers;
  if (projects_ending.length === 0 && hires_starting.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          What&rsquo;s driving the forecast
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Window {forecast_drivers.from_date} → {forecast_drivers.to_date}.
          Shows the assignment endings and new hires that explain the
          chart&rsquo;s forecast tail.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Projects ending — frees consultants
          </h3>
          {projects_ending.length === 0 ? (
            <p className="text-sm text-muted-foreground">None in window.</p>
          ) : (
            <ul className="divide-y rounded-md border bg-background text-sm">
              {projects_ending.map((p) => (
                <li
                  key={`${p.project_id}-${p.end_date}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/projects/${p.project_id}`}
                      className="hover:underline"
                    >
                      <span className="text-muted-foreground">
                        {p.customer_name}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span>{p.project_name}</span>
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      ends {p.end_date} · {p.n_assignments} assignment
                      {p.n_assignments === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Badge variant="outline">
                    {(Number(p.freeing_alloc_sum) * 100).toFixed(0)}% freed
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            New hires starting — adds payroll
          </h3>
          {hires_starting.length === 0 ? (
            <p className="text-sm text-muted-foreground">None in window.</p>
          ) : (
            <ul className="divide-y rounded-md border bg-background text-sm">
              {hires_starting.map((h) => (
                <li
                  key={h.employee_id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/employees/${h.employee_id}`}
                      className="hover:underline"
                    >
                      {h.who_name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      starts {h.hire_date}
                      {h.team && <> · {h.team}</>}
                      {h.role_tier && <> · {h.role_tier}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
