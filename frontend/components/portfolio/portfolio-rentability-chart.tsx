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
import { usePortfolioRentabilitySeries } from "@/lib/api/portfolio-rentability-series";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, shiftMonth, shortLabel } from "@/lib/month";

const MONTHS_BACK = 12; // → 12 prior + current + 3 forecast = 16 points
const MONTHS_FORWARD = 3;

const config = {
  cost: { label: "Cost", color: "var(--chart-1)" },
  revenue_above_cost: {
    label: "Revenue (above cost)",
    color: "var(--chart-2)",
  },
  margin_pct: { label: "Margin %", color: "var(--chart-3)" },
} satisfies ChartConfig;

/** Read-only trailing-window trend chart for the portfolio-rentability
 * report. Window is anchored at "now" and does not shift when the
 * selected detail month changes — by design (user request: chart is
 * an at-a-glance direction indicator, scrubbing happens on the detail
 * block below). Same engine + visual grammar as the team P&L chart. */
export function PortfolioRentabilityChart() {
  const currentMonth = isoMonthOf(new Date());
  const fromMonth = shiftMonth(currentMonth, -MONTHS_BACK);
  const toMonth = shiftMonth(currentMonth, MONTHS_FORWARD);
  const { data, isLoading, isError, error } = usePortfolioRentabilitySeries(
    fromMonth,
    toMonth,
  );

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
          Portfolio P&amp;L — last {MONTHS_BACK} months + {MONTHS_FORWARD}-month forecast
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
                          if (
                            name === "cost" ||
                            name === "revenue_above_cost"
                          ) {
                            return [
                              formatEUR(Number(value).toFixed(2)),
                              name === "cost"
                                ? "Cost"
                                : "Revenue (above cost)",
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
            </ChartContainer>
            <p className="text-xs text-muted-foreground">
              Cost is <span className="font-medium">loaded payroll</span>{" "}
              — the full company salary burden including bench — so margin
              reflects real profitability, not just project P&amp;L. The KPI
              grid below shows project-allocated cost instead, which is
              why its numbers won&rsquo;t match this chart. Revenue is
              T&amp;M plus FP recognized; forecast months extend the engine
              from committed assignments; per-month FP is volatile (lumpy
              recognition); the dashed line marks the actual/forecast
              boundary.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
