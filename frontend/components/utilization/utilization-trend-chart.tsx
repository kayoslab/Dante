"use client";

import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useUtilizationSeries } from "@/lib/api/utilization";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, shiftMonth, shortLabel } from "@/lib/month";

const MONTHS_BACK = 12; // → 12 prior + current + 3 forecast = 16 points
const MONTHS_FORWARD = 3;

const config = {
  allocated_cost: { label: "Allocated", color: "var(--chart-2)" },
  unallocated_cost: { label: "Bench", color: "var(--chart-1)" },
  util_pct_eur: { label: "Util % (€)", color: "var(--chart-3)" },
  util_pct_headcount: {
    label: "Util % (headcount)",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

/** Read-only trailing-window utilization trend. Stacked bars (allocated
 * bottom + bench top = loaded payroll) plus two utilization lines: the
 * EUR-weighted ("are we recovering payroll?") and the headcount-weighted
 * ("are people busy?"). Same anchored-at-now window as the portfolio
 * rentability chart. */
export function UtilizationTrendChart() {
  const currentMonth = isoMonthOf(new Date());
  const fromMonth = shiftMonth(currentMonth, -MONTHS_BACK);
  const toMonth = shiftMonth(currentMonth, MONTHS_FORWARD);
  const { data, isLoading, isError, error } = useUtilizationSeries(
    fromMonth,
    toMonth,
  );

  const chartData = useMemo(() => {
    return (data?.points ?? []).map((p) => {
      const loaded = Number(p.totals.loaded_cost);
      const unallocated = Number(p.totals.unallocated_cost);
      const allocated = Math.max(0, loaded - unallocated);
      const util_pct_eur =
        p.totals.util_pct_eur === null ? null : Number(p.totals.util_pct_eur);
      const util_pct_headcount =
        p.totals.util_pct_headcount === null
          ? null
          : Number(p.totals.util_pct_headcount);
      return {
        month: p.month,
        label: shortLabel(p.month),
        allocated_cost: allocated,
        unallocated_cost: unallocated,
        loaded_cost: loaded,
        util_pct_eur,
        util_pct_headcount,
        is_forecast: p.is_forecast,
      };
    });
  }, [data]);

  const lastActualIdx = useMemo(() => {
    if (chartData.length === 0) return -1;
    let i = -1;
    for (let j = 0; j < chartData.length; j++) {
      if (!chartData[j].is_forecast) i = j;
    }
    return i;
  }, [chartData]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Utilization trend — last {MONTHS_BACK} months + {MONTHS_FORWARD}-month forecast
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-72 w-full" />}
        {isError && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Failed to load series:{" "}
            {error instanceof Error ? error.message : "unknown"}
          </div>
        )}
        {data && chartData.length > 0 && (
          <>
            <ChartContainer config={config} className="h-72 w-full">
              <ComposedChart data={chartData}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" />
                  <YAxis
                    yAxisId="eur"
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
                    }
                  />
                  <YAxis
                    yAxisId="pct"
                    orientation="right"
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    domain={[0, 110]}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label, payload) => {
                          const p = payload?.[0]?.payload as
                            | (typeof chartData)[number]
                            | undefined;
                          return p?.is_forecast
                            ? `${label} (forecast)`
                            : (label as string);
                        }}
                        formatter={(value, name) => {
                          if (
                            name === "util_pct_eur" ||
                            name === "util_pct_headcount"
                          ) {
                            return [
                              value === null
                                ? "—"
                                : `${Number(value).toFixed(1)}%`,
                              name === "util_pct_eur"
                                ? "Util % (€)"
                                : "Util % (headcount)",
                            ];
                          }
                          if (
                            name === "allocated_cost" ||
                            name === "unallocated_cost"
                          ) {
                            return [
                              formatEUR(Number(value).toFixed(2)),
                              name === "allocated_cost" ? "Allocated" : "Bench",
                            ];
                          }
                          return [String(value), String(name)];
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {lastActualIdx >= 0 &&
                    lastActualIdx < chartData.length - 1 && (
                      <ReferenceLine
                        yAxisId="eur"
                        x={chartData[lastActualIdx].label}
                        stroke="var(--muted-foreground)"
                        strokeDasharray="2 2"
                      />
                    )}
                  <Bar
                    yAxisId="eur"
                    dataKey="allocated_cost"
                    stackId="loaded"
                    fill="var(--color-allocated_cost)"
                    fillOpacity={0.85}
                  />
                  <Bar
                    yAxisId="eur"
                    dataKey="unallocated_cost"
                    stackId="loaded"
                    fill="var(--color-unallocated_cost)"
                    fillOpacity={0.85}
                  />
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="util_pct_eur"
                    stroke="var(--color-util_pct_eur)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="util_pct_headcount"
                    stroke="var(--color-util_pct_headcount)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                    connectNulls
                  />
              </ComposedChart>
            </ChartContainer>
            <p className="text-xs text-muted-foreground">
              Bars stack to total loaded payroll (allocated + bench).
              Solid line is EUR-weighted utilization (1 − bench / loaded);
              dashed is headcount-weighted (avg of per-employee util %).
              The two diverge when underused consultants are also the
              expensive ones, or when juniors are overbooked while
              seniors sit. Forecast extends the same engine from
              committed assignments; dashed vertical marks the boundary.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
