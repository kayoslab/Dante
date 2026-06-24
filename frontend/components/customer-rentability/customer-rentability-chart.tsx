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
import { useCustomerRentabilitySeries } from "@/lib/api/customer-rentability";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, shiftMonth, shortLabel } from "@/lib/month";

const MONTHS_BACK = 12;
const MONTHS_FORWARD = 3;

// Reused tokens — `--chart-N` shadcn colors map predictably. We rotate
// through six slots so the top-5 + Other each get a distinct fill.
const CUSTOMER_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function CustomerRentabilityChart() {
  const currentMonth = isoMonthOf(new Date());
  const fromMonth = shiftMonth(currentMonth, -MONTHS_BACK);
  const toMonth = shiftMonth(currentMonth, MONTHS_FORWARD);
  const { data, isLoading, isError, error } = useCustomerRentabilitySeries(
    fromMonth,
    toMonth,
  );

  const { chartData, config, dataKeys, lastActualIdx } = useMemo(() => {
    if (!data) {
      return {
        chartData: [],
        config: {} as ChartConfig,
        dataKeys: [] as string[],
        lastActualIdx: -1,
      };
    }
    const topSet = new Set(data.top_customers.map((t) => t.customer_id));
    const keys = data.top_customers.map((t) => `customer_${t.customer_id}`);
    keys.push("other");

    const cfg: ChartConfig = {};
    data.top_customers.forEach((t, i) => {
      cfg[`customer_${t.customer_id}`] = {
        label: t.customer_name,
        color: CUSTOMER_COLORS[i % CUSTOMER_COLORS.length],
      };
    });
    cfg.other = { label: "Other", color: "var(--muted-foreground)" };
    cfg.top_5_share_pct = {
      label: "Top-5 share %",
      color: "var(--chart-6, var(--foreground))",
    };

    const rows = data.points.map((p) => {
      const row: Record<string, unknown> = {
        label: shortLabel(p.month),
        month: p.month,
        is_forecast: p.is_forecast,
        top_5_share_pct:
          p.top_5_share_pct === null ? null : Number(p.top_5_share_pct),
      };
      let other = 0;
      for (const c of p.customers) {
        const m = Number(c.margin);
        if (topSet.has(c.customer_id)) {
          row[`customer_${c.customer_id}`] = m;
        } else {
          other += m;
        }
      }
      row.other = other;
      return row;
    });

    let lastIdx = -1;
    for (let j = 0; j < rows.length; j++) {
      if (!rows[j].is_forecast) lastIdx = j;
    }

    return {
      chartData: rows,
      config: cfg,
      dataKeys: keys,
      lastActualIdx: lastIdx,
    };
  }, [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Customer margin trend — last {MONTHS_BACK} months + {MONTHS_FORWARD}-month forecast
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
                    Math.abs(v) >= 1000
                      ? `${(v / 1000).toFixed(0)}k`
                      : String(v)
                  }
                />
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  domain={[0, 100]}
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
                        if (name === "top_5_share_pct") {
                          return [
                            value === null
                              ? "—"
                              : `${Number(value).toFixed(1)}%`,
                            "Top-5 share",
                          ];
                        }
                        const cfgEntry = config[name as keyof typeof config];
                        const label =
                          (cfgEntry as { label?: string } | undefined)
                            ?.label ?? String(name);
                        return [formatEUR(Number(value).toFixed(2)), label];
                      }}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {lastActualIdx >= 0 &&
                  lastActualIdx < chartData.length - 1 && (
                    <ReferenceLine
                      yAxisId="eur"
                      x={chartData[lastActualIdx].label as string}
                      stroke="var(--muted-foreground)"
                      strokeDasharray="2 2"
                    />
                  )}
                {dataKeys.map((k) => (
                  <Bar
                    key={k}
                    yAxisId="eur"
                    dataKey={k}
                    stackId="margin"
                    fill={
                      (config[k] as { color?: string } | undefined)?.color ??
                      "var(--muted-foreground)"
                    }
                    fillOpacity={0.85}
                  />
                ))}
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="top_5_share_pct"
                  stroke={
                    (config.top_5_share_pct as { color?: string }).color
                  }
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              </ComposedChart>
            </ChartContainer>
            <p className="text-xs text-muted-foreground">
              Bars stack each month&rsquo;s margin contribution by customer
              — top 5 (by trailing aggregate margin) hold their colors;
              everything else collapses into Other. A negative bar
              segment is a money-pit customer for that month. The
              line tracks the top-5 share of positive margin, on the
              right axis — a rising line means concentration risk is
              growing.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
