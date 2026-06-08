"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { GenderGapRow } from "@/lib/api/salary-insights";
import { formatEUR } from "@/lib/format";
import { cn } from "@/lib/utils";

const eur = (n: number) => formatEUR(n);

const config = {
  median_female: { label: "Median female", color: "var(--chart-2)" },
  median_male: { label: "Median male", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function GenderGapChart({ rows }: { rows: GenderGapRow[] }) {
  // Only render groups where AT LEAST ONE side cleared the n=3 disclosure
  // guard. The backend already filters with HAVING so empty rows shouldn't
  // come through, but defensive against future tweaks.
  const visible = rows.filter(
    (r) => r.median_female !== null || r.median_male !== null,
  );
  if (visible.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No group has at least 3 employees of both genders (disclosure
        guard suppresses smaller cells).
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ChartContainer config={config} className="h-64 w-full">
        <BarChart
          data={visible}
          margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="group_key"
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
                  const label =
                    name === "median_female" ? "Median female" : "Median male";
                  return [eur(Number(value)), label];
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="median_female"
            fill="var(--color-median_female)"
            radius={[3, 3, 0, 0]}
          />
          <Bar
            dataKey="median_male"
            fill="var(--color-median_male)"
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Group</th>
              <th className="px-3 py-2 text-right font-medium">n ♀</th>
              <th className="px-3 py-2 text-right font-medium">Median ♀</th>
              <th className="px-3 py-2 text-right font-medium">n ♂</th>
              <th className="px-3 py-2 text-right font-medium">Median ♂</th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="(median_male − median_female) / median_male × 100. Positive = males earn more."
              >
                Gap % (♀ below ♂)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map((r) => {
              const gap = r.gap_pct_female_below_male ?? null;
              const gapTone =
                gap === null
                  ? "text-muted-foreground"
                  : gap > 5
                    ? "text-red-700"
                    : gap > 0
                      ? "text-amber-700"
                      : "text-emerald-700";
              return (
                <tr key={r.group_key ?? "?"} className="hover:bg-muted/20">
                  <td className="px-3 py-2">{r.group_key}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.n_female ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.median_female != null ? eur(r.median_female) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.n_male ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.median_male != null ? eur(r.median_male) : "—"}
                  </td>
                  <td
                    className={cn("px-3 py-2 text-right tabular-nums", gapTone)}
                  >
                    {gap != null ? `${gap.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Cells with fewer than 3 employees of either gender are redacted (—)
        to protect individuals. Gap is calculated as{" "}
        <code>(median_male − median_female) / median_male × 100</code>.
      </p>
    </div>
  );
}
