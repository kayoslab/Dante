"use client";

import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
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
import { useTeamMonthlySeries } from "@/lib/api/team-series";
import { isoMonthOf, shiftMonth, shortLabel } from "@/lib/month";
import { formatEUR } from "@/lib/format";

const MONTHS_BACK = 6; // → 6 prior + current + 3 forecast = 10 points
const MONTHS_FORWARD = 3;

const config = {
  cost: { label: "Cost", color: "var(--chart-1)" },
  revenue_above_cost: {
    label: "Revenue (above cost)",
    color: "var(--chart-2)",
  },
  margin_pct: { label: "Margin %", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function TeamMonthlyPLChart({ slug }: { slug: string }) {
  const currentMonth = isoMonthOf(new Date());
  const fromMonth = shiftMonth(currentMonth, -MONTHS_BACK);
  const toMonth = shiftMonth(currentMonth, MONTHS_FORWARD);
  const { data, isLoading, isError, error } = useTeamMonthlySeries(
    slug,
    fromMonth,
    toMonth,
  );

  /** Recharts wants two stacked bar series. The bottom is `cost`, the
   * top is `max(revenue - cost, 0)` — together they show "revenue
   * standing tall over cost" when the team is profitable, and just the
   * cost bar when the team is losing money (revenue stack stays at 0,
   * margin% line goes negative). Recharts doesn't render negative
   * stacks gracefully so we keep them clamped at 0 and rely on the
   * margin% line + tooltip for the loss signal. */
  const chartData = useMemo(() => {
    return (data?.points ?? []).map((p) => {
      const cost = Number(p.cost);
      const revenue = Number(p.revenue);
      const margin_pct = p.margin_pct === null ? null : Number(p.margin_pct);
      return {
        month: p.month,
        label: shortLabel(p.month),
        cost,
        revenue,
        revenue_above_cost: Math.max(0, revenue - cost),
        margin_pct,
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
          Monthly P&amp;L — last {MONTHS_BACK} months + {MONTHS_FORWARD}-month forecast
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-72 w-full" />}
        {isError && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Failed to load series: {error instanceof Error ? error.message : "unknown"}
          </div>
        )}
        {data && chartData.length > 0 && (
          <>
            <ChartContainer config={config} className="h-72 w-full">
              <ResponsiveContainer>
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
                    domain={[
                      (d: number) => Math.min(0, Math.floor(d / 10) * 10),
                      (d: number) => Math.max(50, Math.ceil(d / 10) * 10),
                    ]}
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
                        formatter={(value, name, item) => {
                          if (name === "margin_pct") {
                            return [
                              value === null
                                ? "—"
                                : `${Number(value).toFixed(1)}%`,
                              item.payload?.margin_pct === null
                                ? ""
                                : "Margin %",
                            ];
                          }
                          if (name === "cost" || name === "revenue_above_cost") {
                            return [
                              formatEUR(Number(value).toFixed(2)),
                              name === "cost" ? "Cost" : "Revenue (above cost)",
                            ];
                          }
                          return [String(value), String(name)];
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {/* Vertical line between the last actual month and the
                      first forecast month so the eye knows where the
                      uncommitted territory starts. */}
                  {lastActualIdx >= 0 && lastActualIdx < chartData.length - 1 && (
                    <ReferenceLine
                      yAxisId="eur"
                      x={chartData[lastActualIdx].label}
                      stroke="var(--muted-foreground)"
                      strokeDasharray="2 2"
                    />
                  )}
                  <Bar
                    yAxisId="eur"
                    dataKey="cost"
                    stackId="pl"
                    fill="var(--color-cost)"
                    fillOpacity={0.85}
                  />
                  <Bar
                    yAxisId="eur"
                    dataKey="revenue_above_cost"
                    stackId="pl"
                    fill="var(--color-revenue_above_cost)"
                    fillOpacity={0.85}
                  />
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="margin_pct"
                    stroke="var(--color-margin_pct)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartContainer>
            <p className="text-xs text-muted-foreground">
              Forecast months use the same engine as history — they sum
              committed assignment rows only, no speculative pipeline. The
              dashed vertical line marks the transition from actuals to
              forecast.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
