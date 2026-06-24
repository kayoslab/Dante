"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { CustomerRentabilityChart } from "@/components/customer-rentability/customer-rentability-chart";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type CustomerRentabilityMonth,
  useCustomerRentabilityMonth,
} from "@/lib/api/customer-rentability";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { cn } from "@/lib/utils";

export function CustomerRentabilityClient() {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);
  const { data, isLoading, isError, error } = useCustomerRentabilityMonth(month);
  const isFuture = month > todayMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Customer rentability
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who carries us, and how concentrated is the risk. Pareto sorted
          by margin contribution; the trend chart on top shows the top-5
          customer mix with concentration percentage on the right axis.
        </p>
      </div>

      <CustomerRentabilityChart />

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
              <ConcentrationKpis data={data} />
              <CustomerPareto data={data} />
            </>
          )}
        </CardContent>
      </Card>

      {data && data.ending_projects.length > 0 && (
        <ConcentrationAtRisk data={data} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concentration KPIs (4 tiles, with HHI explanation)
// ---------------------------------------------------------------------------

function ConcentrationKpis({ data }: { data: CustomerRentabilityMonth }) {
  const c = data.concentration;
  if (c === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No customer contributed positive margin this month.
      </p>
    );
  }
  const top1 = Number(c.top_1_share_pct);
  const top5 = Number(c.top_5_share_pct);
  const hhi = Number(c.hhi);
  const top5Tone =
    top5 > 70
      ? "text-red-700"
      : top5 > 50
        ? "text-amber-700"
        : "text-emerald-700";
  const hhiTone =
    hhi > 2500
      ? "text-red-700"
      : hhi > 1500
        ? "text-amber-700"
        : "text-emerald-700";
  const hhiBand =
    hhi > 2500 ? "high" : hhi > 1500 ? "moderate" : "diversified";

  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Concentration of margin
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <KpiTile
          label="Top-1 customer"
          value={`${top1.toFixed(1)}%`}
          sub={
            <span className="text-muted-foreground">of positive margin</span>
          }
        />
        <KpiTile
          label="Top-5 customers"
          value={<span className={top5Tone}>{top5.toFixed(1)}%</span>}
          sub={
            <span className="text-muted-foreground">of positive margin</span>
          }
        />
        <KpiTile
          label="≥10% threshold"
          value={`${c.n_customers_above_10pct}`}
          sub={
            <span className="text-muted-foreground">
              customers individually carry ≥10%
            </span>
          }
        />
        <KpiTile
          label="HHI"
          value={<span className={hhiTone}>{hhi.toFixed(0)}</span>}
          sub={
            <span className="text-muted-foreground">{hhiBand}</span>
          }
          tooltip="Herfindahl-Hirschman Index — sum of squared customer-share-of-margin percentages. Scale 0–10000. Below 1500 = diversified, 1500–2500 = moderate concentration, above 2500 = high concentration. Antitrust regulators use the same thresholds, so it's a defensible board-meeting number."
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Based on {c.n_positive_contributors} customers with positive margin
        this month (total {formatEUR(c.total_positive_margin)}). Loss-making
        customers are excluded from concentration math — losing them would
        reduce risk, not concentrate it.
      </p>
    </section>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tooltip,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tooltip?: string;
}) {
  return (
    <div className="rounded-md border bg-background p-3" title={tooltip}>
      <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {tooltip && (
          <span
            className="cursor-help text-muted-foreground/70"
            aria-label={tooltip}
          >
            ⓘ
          </span>
        )}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer Pareto table
// ---------------------------------------------------------------------------

function CustomerPareto({ data }: { data: CustomerRentabilityMonth }) {
  if (data.customers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No customers with active projects this month.
      </p>
    );
  }
  const totalPositive =
    data.concentration === null
      ? 0
      : Number(data.concentration.total_positive_margin);

  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Customers, sorted by margin contribution
      </h3>
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Customer</th>
              <th className="px-3 py-2 text-right font-medium">N projects</th>
              <th className="px-3 py-2 text-right font-medium">Revenue</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Margin</th>
              <th className="px-3 py-2 text-right font-medium">Margin %</th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Share of total positive margin"
              >
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.customers.map((c) => {
              const margin = Number(c.margin);
              const marginPct =
                c.margin_pct === null ? null : Number(c.margin_pct);
              const share =
                margin > 0 && totalPositive > 0
                  ? (margin / totalPositive) * 100
                  : null;
              const marginTone =
                margin < 0 ? "text-red-700" : "text-emerald-700";
              const marginPctTone =
                marginPct === null
                  ? ""
                  : marginPct < 0
                    ? "text-red-700"
                    : marginPct < 10
                      ? "text-amber-700"
                      : "text-emerald-700";
              return (
                <tr key={c.customer_id} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <Link
                      href={`/customers/${c.customer_id}`}
                      className="hover:underline"
                    >
                      {c.customer_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {c.n_projects}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(c.revenue)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEUR(c.cost)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      marginTone,
                    )}
                  >
                    {margin >= 0 ? "" : "−"}
                    {formatEUR(Math.abs(margin).toFixed(2))}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      marginPctTone,
                    )}
                  >
                    {marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {share === null ? "—" : `${share.toFixed(1)}%`}
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
// Concentration-at-risk panel
// ---------------------------------------------------------------------------

function ConcentrationAtRisk({ data }: { data: CustomerRentabilityMonth }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Concentration at risk</CardTitle>
        <p className="text-xs text-muted-foreground">
          Customers whose project is fully winding down between{" "}
          {data.ending_window.from} and {data.ending_window.to}. No
          remaining assignment extends beyond the window — losing these
          contracts will hit the next quarter directly. Cross-reference
          with the Pareto above: an ending project on a top-5 customer
          is a board-meeting headline.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border bg-background text-sm">
          {data.ending_projects.map((p) => (
            <li
              key={p.project_id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <Link
                  href={`/customers/${p.customer_id}`}
                  className="font-medium hover:underline"
                >
                  {p.customer_name}
                </Link>
                <span className="mx-1 text-muted-foreground">/</span>
                <Link
                  href={`/projects/${p.project_id}`}
                  className="hover:underline"
                >
                  {p.project_name}
                </Link>
              </div>
              <div className="text-xs text-muted-foreground">
                ends {p.project_ends_date}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
