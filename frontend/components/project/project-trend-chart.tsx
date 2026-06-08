"use client";

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
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
import { useProjectMonthlySeries } from "@/lib/api/project-series";
import { isoMonthOf, shiftMonth, shortLabel } from "@/lib/month";
import { formatEUR } from "@/lib/format";

const MONTHS_BACK = 11; // → 12 points ending at current month

const tmConfig = {
  revenue: { label: "Planned revenue", color: "var(--chart-2)" },
  cost: { label: "Cost", color: "var(--chart-1)" },
  margin: { label: "Margin", color: "var(--chart-3)" },
  tracked_revenue: { label: "Actual revenue (tracked)", color: "var(--chart-5)" },
} satisfies ChartConfig;

const fpConfig = {
  recognized_revenue: {
    label: "Recognized revenue (this month)",
    color: "var(--chart-2)",
  },
  cost: { label: "Cost (this month)", color: "var(--chart-1)" },
  cumulative_recognized: {
    label: "Cumulative recognized",
    color: "var(--chart-5)",
  },
  cumulative_cost: { label: "Cumulative cost", color: "var(--chart-1)" },
  cumulative_margin: {
    label: "Cumulative margin",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

export function ProjectTrendChart({ projectId }: { projectId: number }) {
  const toMonth = isoMonthOf(new Date());
  const fromMonth = shiftMonth(toMonth, -MONTHS_BACK);
  const { data, isLoading, isError, error } = useProjectMonthlySeries(
    projectId,
    fromMonth,
    toMonth,
  );

  const chartData = useMemo(() => {
    return (data?.points ?? []).map((p) => ({
      month: p.month,
      label: shortLabel(p.month),
      revenue: p.revenue ? Number(p.revenue) : 0,
      cost: p.cost ? Number(p.cost) : 0,
      margin: p.margin ? Number(p.margin) : null,
      cumulative_cost: p.cumulative_cost ? Number(p.cumulative_cost) : 0,
      // FP recognition fields. Null when no recognition rule applies so the
      // chart shows gaps rather than misleading zeros.
      recognized_revenue:
        p.recognized_revenue != null ? Number(p.recognized_revenue) : null,
      cumulative_recognized:
        p.cumulative_recognized_revenue != null
          ? Number(p.cumulative_recognized_revenue)
          : null,
      cumulative_margin:
        p.cumulative_margin != null ? Number(p.cumulative_margin) : null,
      over_budget: p.over_budget ?? false,
      rate_unresolved_days: p.rate_unresolved_days ?? 0,
      // Tracked revenue only when a Personio mapping exists; otherwise null
      // so the line renders gaps (rather than collapsing to zero) for months
      // before the mapping was created.
      tracked_revenue:
        p.has_personio_mapping && p.tracked_revenue
          ? Number(p.tracked_revenue)
          : null,
    }));
  }, [data]);

  const hasAnyTracked = useMemo(
    () => chartData.some((p) => p.tracked_revenue !== null),
    [chartData],
  );

  // Highlight months where revenue is silently zero because no project rate
  // resolves for the billable days. Helps catch the case where a project's
  // assignments span a window the rate sheet doesn't cover yet.
  const gapMonths = useMemo(
    () => chartData.filter((p) => p.rate_unresolved_days > 0),
    [chartData],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {data?.billing_model === "fixed_price"
            ? "FP P&L — last 12 months"
            : "Revenue / cost / margin — last 12 months"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-72 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        )}
        {gapMonths.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">
                {gapMonths.length} month
                {gapMonths.length === 1 ? "" : "s"} have unresolved rates
              </span>{" "}
              ({gapMonths.map((g) => g.label).join(", ")}). Revenue for these
              periods is silently zero — typically the project rate&apos;s{" "}
              <code>valid_from</code> is later than the assignment&apos;s
              start. Open one of those months in the breakdown above for
              per-assignment detail.
            </span>
          </div>
        )}
        {data && data.billing_model === "time_and_material" && (
          <TmChart data={chartData} showTracked={hasAnyTracked} />
        )}
        {data && data.billing_model === "fixed_price" && (
          <FpChart data={chartData} agreed={data.agreed_amount_eur} />
        )}
      </CardContent>
    </Card>
  );
}

function TmChart({
  data,
  showTracked,
}: {
  data: {
    label: string;
    revenue: number;
    cost: number;
    margin: number | null;
    tracked_revenue: number | null;
  }[];
  showTracked: boolean;
}) {
  return (
    <ChartContainer config={tmConfig} className="h-72 w-full">
      <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          tickFormatter={(v: number) =>
            v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
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
                const formatted = formatEUR(n);
                return [`${formatted}  `, tmConfig[name as keyof typeof tmConfig]?.label ?? String(name)];
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <ReferenceLine y={0} stroke="var(--border)" />
        <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="cost" fill="var(--color-cost)" radius={[3, 3, 0, 0]} />
        <Line
          dataKey="margin"
          stroke="var(--color-margin)"
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
          connectNulls
        />
        {showTracked && (
          <Line
            dataKey="tracked_revenue"
            stroke="var(--color-tracked_revenue)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  );
}

function FpChart({
  data,
  agreed,
}: {
  data: {
    label: string;
    cost: number;
    cumulative_cost: number;
    recognized_revenue: number | null;
    cumulative_recognized: number | null;
    cumulative_margin: number | null;
    over_budget: boolean;
  }[];
  agreed: string | null | undefined;
}) {
  const agreedNum = agreed ? Number(agreed) : null;
  return (
    <ChartContainer config={fpConfig} className="h-72 w-full">
      <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          tickFormatter={(v: number) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
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
                const formatted = formatEUR(n);
                return [`${formatted}  `, fpConfig[name as keyof typeof fpConfig]?.label ?? String(name)];
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {agreedNum !== null && (
          <ReferenceLine
            y={agreedNum}
            stroke="var(--chart-4)"
            strokeDasharray="4 4"
            label={{
              value: "Agreed budget",
              position: "insideTopRight",
              fontSize: 11,
              fill: "var(--chart-4)",
            }}
          />
        )}
        {/* Per-month bars: recognized revenue + cost side-by-side so each
            month's P&L delta is visible at a glance. Cumulative margin line
            is the headline answer to "is this project profitable so far?". */}
        <Bar
          dataKey="recognized_revenue"
          fill="var(--color-recognized_revenue)"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="cost"
          fill="var(--color-cost)"
          radius={[3, 3, 0, 0]}
        />
        <Line
          type="monotone"
          dataKey="cumulative_recognized"
          stroke="var(--color-cumulative_recognized)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="cumulative_cost"
          stroke="var(--color-cumulative_cost)"
          strokeDasharray="4 4"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
        <Line
          type="monotone"
          dataKey="cumulative_margin"
          stroke="var(--color-cumulative_margin)"
          strokeWidth={2.5}
          dot={{ r: 3 }}
          connectNulls={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
