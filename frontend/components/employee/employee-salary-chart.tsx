"use client";

import { Fragment, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";

import {
  useEmployeeSalaryTrajectory,
  type EmployeeSalaryPoint,
} from "@/lib/api/employees";
import { cn } from "@/lib/utils";

const config = {
  annual: { label: "Annual salary (€)", color: "var(--chart-1)" },
} satisfies ChartConfig;

import { formatEUR } from "@/lib/format";

const eur = (n: number) => formatEUR(n);

export function EmployeeSalaryChart({ employeeId }: { employeeId: number }) {
  const { data, isLoading, isError } = useEmployeeSalaryTrajectory(employeeId);

  // Step-line: each event sets a new annual salary that persists until the
  // next event. Sort by date ascending.
  const points = useMemo(() => {
    if (!data) return [];
    return [...data]
      .sort((a, b) => a.effective_date.localeCompare(b.effective_date))
      .map((e) => ({
        date: e.effective_date,
        annual: Number(e.annual_eur),
        previous_annual_eur: e.previous_annual_eur
          ? Number(e.previous_annual_eur)
          : null,
        delta_eur: e.delta_eur ? Number(e.delta_eur) : null,
        delta_pct: e.delta_pct ? Number(e.delta_pct) : null,
        source: e.source,
      }));
  }, [data]);

  const totals = useMemo(() => {
    if (points.length === 0) return null;
    const first = points[0].annual;
    const last = points[points.length - 1].annual;
    const totalDelta = last - first;
    const totalPct = first > 0 ? (totalDelta / first) * 100 : null;
    return { first, last, totalDelta, totalPct };
  }, [points]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Salary trajectory</CardTitle>
        {totals !== null && (
          <p className="text-xs text-muted-foreground">
            {points.length} change{points.length === 1 ? "" : "s"} on file ·{" "}
            {eur(totals.first)} → {eur(totals.last)}
            {totals.totalPct !== null && (
              <>
                {" "}
                ·{" "}
                <span
                  className={cn(
                    "font-medium",
                    totals.totalDelta >= 0 ? "text-emerald-700" : "text-red-700",
                  )}
                >
                  {totals.totalDelta >= 0 ? "+" : ""}
                  {eur(totals.totalDelta)} ({totals.totalPct.toFixed(1)}%)
                </span>{" "}
                lifetime
              </>
            )}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-60 w-full" />}
        {isError && (
          <p className="text-sm text-red-600">Failed to load salary history</p>
        )}
        {data && points.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No salary events on file.
          </p>
        )}
        {points.length > 0 && (
          <>
            <ChartContainer config={config} className="h-60 w-full">
              <ComposedChart
                data={points}
                margin={{ top: 18, right: 20, left: 0, bottom: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
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
                  domain={["auto", "auto"]}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label) => `Effective ${label}`}
                      formatter={(value, _name, item) => {
                        const p = item?.payload as
                          | (typeof points)[number]
                          | undefined;
                        const lines: React.ReactNode[] = [
                          <div key="now" className="font-semibold">
                            {eur(Number(value))}
                          </div>,
                        ];
                        if (p?.delta_pct != null && p.delta_eur != null) {
                          lines.push(
                            <div
                              key="delta"
                              className={cn(
                                "text-xs tabular-nums",
                                p.delta_eur >= 0
                                  ? "text-emerald-700"
                                  : "text-red-700",
                              )}
                            >
                              {p.delta_eur >= 0 ? "+" : ""}
                              {eur(p.delta_eur)} ({p.delta_pct.toFixed(1)}%)
                            </div>,
                          );
                        }
                        if (p?.previous_annual_eur != null) {
                          lines.push(
                            <div
                              key="prev"
                              className="text-xs text-muted-foreground tabular-nums"
                            >
                              from {eur(p.previous_annual_eur)}
                            </div>,
                          );
                        }
                        // Recharts' formatter returns a [value, name] tuple
                        // that the chart renders as siblings in a flex row.
                        // Shortcut Fragment `<>...</>` can't take a key, and
                        // React warns when array siblings are unkeyed — use
                        // the explicit Fragment form instead.
                        return [
                          <Fragment key="lines">{lines}</Fragment>,
                          "",
                        ];
                      }}
                    />
                  }
                />
                <Line
                  type="stepAfter"
                  dataKey="annual"
                  stroke="var(--color-annual)"
                  strokeWidth={2}
                  dot={{ r: 4, strokeWidth: 1, fill: "var(--color-annual)" }}
                />
                {points
                  .filter((p) => p.delta_pct !== null)
                  .map((p) => (
                    <ReferenceDot
                      key={`${p.date}-anno`}
                      x={p.date}
                      y={p.annual}
                      r={0}
                      label={{
                        value: `${p.delta_pct! >= 0 ? "+" : ""}${p.delta_pct!.toFixed(0)}%`,
                        position: p.delta_pct! >= 0 ? "top" : "bottom",
                        fontSize: 10,
                        fill:
                          p.delta_pct! >= 0
                            ? "rgb(4, 120, 87)"
                            : "rgb(185, 28, 28)",
                      }}
                    />
                  ))}
              </ComposedChart>
            </ChartContainer>
            <ChangesTable rows={points} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ChangesTable({
  rows,
}: {
  rows: {
    date: string;
    annual: number;
    previous_annual_eur: number | null;
    delta_eur: number | null;
    delta_pct: number | null;
    source: string | null | undefined;
  }[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Effective</th>
            <th className="px-3 py-2 text-right font-medium">From</th>
            <th className="px-3 py-2 text-right font-medium">To</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
            <th className="px-3 py-2 text-right font-medium">Δ %</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {[...rows].reverse().map((r) => {
            const positive = r.delta_eur != null && r.delta_eur >= 0;
            const tone =
              r.delta_eur == null
                ? "text-muted-foreground"
                : positive
                  ? "text-emerald-700"
                  : "text-red-700";
            return (
              <tr key={r.date} className="hover:bg-muted/20">
                <td className="px-3 py-2 tabular-nums">{r.date}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {r.previous_annual_eur != null
                    ? eur(r.previous_annual_eur)
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {eur(r.annual)}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", tone)}>
                  {r.delta_eur != null
                    ? `${positive ? "+" : ""}${eur(r.delta_eur)}`
                    : "—"}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", tone)}>
                  {r.delta_pct != null
                    ? `${positive ? "+" : ""}${r.delta_pct.toFixed(1)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.source ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
