"use client";

/** Personal / freelancer P&L trend chart cards.
 *
 * Split out of consultant-monthly-breakdown.tsx so recharts (~400 KB
 * minified) is only pulled into the bundle when the trend card is
 * actually rendered — the detail pages import these through
 * `next/dynamic`, so the monthly-breakdown card, tables and KPIs ship
 * without the charting library.
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeMonthlySeries } from "@/lib/api/employees";
import { useFreelancerMonthlySeries } from "@/lib/api/freelancers";
import { formatEUR } from "@/lib/format";
import { cn } from "@/lib/utils";

const trendConfig = {
  cost: { label: "Cost", color: "var(--chart-2)" },
  revenue: { label: "Revenue", color: "var(--chart-1)" },
  margin: { label: "Margin", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function EmployeeTrendChartCard({
  employeeId,
}: {
  employeeId: number;
}) {
  const { data, isLoading, isError } = useEmployeeMonthlySeries(
    employeeId, 6, 3,
  );
  const points =
    data?.points.map((p) => ({
      month: p.month,
      cost: p.monthly_cost_full ? Number(p.monthly_cost_full) : 0,
      revenue: Number(p.revenue),
      margin: Number(p.margin),
      is_forecast: p.is_forecast,
      under_contract: p.under_contract,
    })) ?? [];
  return (
    <TrendChartCard
      title="Personal P&L trend"
      todayMonth={data?.today_month ?? ""}
      points={points}
      isLoading={isLoading}
      isError={isError}
    />
  );
}

export function FreelancerTrendChartCard({
  freelancerId,
}: {
  freelancerId: number;
}) {
  const { data, isLoading, isError } = useFreelancerMonthlySeries(
    freelancerId, 6, 3,
  );
  const points =
    data?.points.map((p) => ({
      month: p.month,
      cost: Number(p.cost),
      revenue: Number(p.revenue),
      margin: Number(p.margin),
      is_forecast: p.is_forecast,
      under_contract: true,
    })) ?? [];
  return (
    <TrendChartCard
      title="Monthly P&L trend"
      todayMonth={data?.today_month ?? ""}
      points={points}
      isLoading={isLoading}
      isError={isError}
    />
  );
}

type TrendPoint = {
  month: string;
  cost: number;
  revenue: number;
  margin: number;
  is_forecast: boolean;
  under_contract: boolean;
};

function TrendChartCard({
  title,
  todayMonth,
  points,
  isLoading,
  isError,
}: {
  title: string;
  todayMonth: string;
  points: TrendPoint[];
  isLoading: boolean;
  isError: boolean;
}) {
  // Quick aggregate over the visible window (history-only — forecast is
  // speculative and shouldn't anchor the headline).
  const history = points.filter((p) => !p.is_forecast && p.under_contract);
  const sumCost = history.reduce((s, p) => s + p.cost, 0);
  const sumRev = history.reduce((s, p) => s + p.revenue, 0);
  const sumMargin = sumRev - sumCost;
  // Cost-based margin %: "of payroll, how much was covered/exceeded". Same
  // formula as the per-month KPI on the breakdown card, so the trend
  // aggregate reconciles with the single-month numbers.
  const aggPct = sumCost > 0 ? (sumMargin / sumCost) * 100 : null;
  const aggTone = sumMargin >= 0 ? "text-emerald-700" : "text-red-700";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          6 months history + 3 months forecast. Forecast bars use current
          salary & active future assignments. Tracked-hours-based FP
          recognition is 0 in months without logged hours yet.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-60 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">Failed to load series</p>
        )}
        {!isLoading && !isError && history.length > 0 && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">
              Last {history.length} months under contract:{" "}
            </span>
            <span className="tabular-nums">
              {formatEUR(sumRev.toFixed(2))} revenue,{" "}
              {formatEUR(sumCost.toFixed(2))} cost,{" "}
            </span>
            <span className={cn("font-semibold tabular-nums", aggTone)}>
              {formatEUR(sumMargin.toFixed(2))} margin
              {aggPct !== null && ` (${aggPct.toFixed(1)}%)`}
            </span>
          </div>
        )}
        {points.length > 0 && (
          <ChartContainer config={trendConfig} className="h-64 w-full">
            <ComposedChart
              data={points}
              margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tickFormatter={(v: number) =>
                  Math.abs(v) >= 1000
                    ? `${(v / 1000).toFixed(0)}k`
                    : String(v)
                }
                tickLine={false}
                axisLine={false}
                width={55}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => {
                      const n = Number(value);
                      const label =
                        name === "cost"
                          ? "Cost"
                          : name === "revenue"
                            ? "Revenue"
                            : "Margin";
                      return [formatEUR(n), label];
                    }}
                  />
                }
              />
              {todayMonth && (
                <ReferenceLine
                  x={todayMonth}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="3 3"
                  label={{
                    value: "today",
                    position: "insideTopLeft",
                    fill: "var(--muted-foreground)",
                    fontSize: 10,
                  }}
                />
              )}
              <Bar
                dataKey="revenue"
                fill="var(--color-revenue)"
                radius={[3, 3, 0, 0]}
              />
              <Bar
                dataKey="cost"
                fill="var(--color-cost)"
                radius={[3, 3, 0, 0]}
              />
              <Line
                type="monotone"
                dataKey="margin"
                stroke="var(--color-margin)"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              <ChartLegend content={<ChartLegendContent />} />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
