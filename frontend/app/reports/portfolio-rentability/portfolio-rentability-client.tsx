"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ProjectTable } from "@/components/portfolio/portfolio-project-table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortfolioMonthly } from "@/lib/api/portfolio";
import {
  type PortfolioRentabilitySeriesPoint,
  usePortfolioRentabilitySeries,
} from "@/lib/api/portfolio-rentability-series";
import type { PortfolioMonthly } from "@/lib/api/types";
import { formatEUR } from "@/lib/format";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

// Chart components pull in recharts (~400 KB minified). Load them on
// demand so the page shell, KPIs and tables paint without it.
const PortfolioRentabilityChart = dynamic(
  () => import("@/components/portfolio/portfolio-rentability-chart").then((m) => m.PortfolioRentabilityChart),
  { loading: () => <Skeleton className="h-96 w-full" /> },
);

/** Client half of the portfolio-rentability report.
 *
 * The page is organised as a C-level monthly P&L:
 *   1. Trailing-window trend chart (loaded-payroll cost basis)
 *   2. Selected-month income-statement block + prior-month delta
 *   3. Bench summary (4 KPI tiles + link out to the utilization report)
 *   4. Per-project P&L table
 *   5. FP recognition context (collapsed — CFO-only detail)
 *
 * Operating result, operating margin, and the delta are computed off
 * the same `computePortfolioMonthlyTotals` engine that backs the trend
 * — so the headline number on this card always matches the chart line. */
export function PortfolioRentabilityClient() {
  const todayMonth = isoMonthOf(new Date());
  const [month, setMonth] = useState<string>(() => todayMonth);
  const { data, isLoading, isError, error } = usePortfolioMonthly(month);
  // Same window as the chart — TanStack dedupes via query key so this
  // hook reuses the chart's cache, no extra fetch.
  const trendQuery = usePortfolioRentabilitySeries(
    shiftMonth(todayMonth, -12),
    shiftMonth(todayMonth, +3),
  );
  const isFuture = month > todayMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Portfolio rentability
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monthly operating result with trailing 12-month trend plus
          3-month forecast. Cost is loaded payroll — what we&rsquo;re
          paying whether or not it landed on a billable project.
        </p>
      </div>

      <PortfolioRentabilityChart />

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
          {data && (
            <div className="text-sm text-muted-foreground">
              {data.n_active_projects} active projects ({data.n_tm_projects}{" "}
              T&amp;M
              {data.n_fp_projects > 0 ? `, ${data.n_fp_projects} FP` : ""})
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-8">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {isError && (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load"}
            </p>
          )}
          {data && (
            <>
              <MonthlyPL
                data={data}
                month={month}
                seriesPoints={trendQuery.data?.points ?? []}
              />
              <ProjectPLBlock data={data} />
              <FpContext data={data} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly P&L — income-statement layout + prior-month delta
// ---------------------------------------------------------------------------

function MonthlyPL({
  data,
  month,
  seriesPoints,
}: {
  data: PortfolioMonthly;
  month: string;
  seriesPoints: PortfolioRentabilitySeriesPoint[];
}) {
  // Income-statement numbers, all in EUR.
  const tm_revenue = Number(data.tm_revenue);
  const fp_revenue = Number(data.fp_recognized_revenue ?? "0");
  const total_revenue = tm_revenue + fp_revenue;

  // Total loaded payroll comes from the bench aggregation (authoritative
  // employee-side calculation). Allocated is derived as Total − Bench
  // so the income statement ties exactly. The project-side total_cost
  // can drift slightly from this residual because of contract proration
  // / FTE rounding; the bench-side numbers are what the chart already
  // uses, so the page stays internally consistent.
  const total_loaded = Number(data.bench.total_loaded_cost);
  const bench_cost = Number(data.bench.total_unallocated_cost);
  const allocated_cost = total_loaded - bench_cost;
  // Freelancer spend (entered hours × daily rate÷8). Revenue includes the
  // work they delivered, so the cost side must carry their invoices too —
  // matches the trend-series margin, which uses the same total.
  const freelancer_cost = Number(data.freelancer_cost ?? "0");
  const total_cost = total_loaded + freelancer_cost;

  const operating_result = total_revenue - total_cost;
  const operating_margin_pct =
    total_revenue > 0 ? (operating_result / total_revenue) * 100 : null;

  // Prior month from the trend series (loaded-payroll basis — same
  // engine as the current-month numbers above). If the selected month
  // sits outside the trend window, the delta line just doesn't render.
  const priorMonth = useMemo(() => shiftMonth(month, -1), [month]);
  const priorPoint = useMemo(
    () => seriesPoints.find((p) => p.month === priorMonth) ?? null,
    [seriesPoints, priorMonth],
  );
  const prior_margin =
    priorPoint === null ? null : Number(priorPoint.margin);
  const prior_margin_pct =
    priorPoint === null || priorPoint.margin_pct === null
      ? null
      : Number(priorPoint.margin_pct);
  const delta_margin =
    prior_margin === null ? null : operating_result - prior_margin;
  const delta_margin_pct_pp =
    operating_margin_pct === null || prior_margin_pct === null
      ? null
      : operating_margin_pct - prior_margin_pct;

  const opTone = opTone_(operating_result);

  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Monthly P&amp;L
      </h3>
      <div className="rounded-md border bg-background">
        <PLTable
          rows={[
            { kind: "section", label: "Revenue" },
            { kind: "line", label: "T&M", value: tm_revenue },
            {
              kind: "line",
              label: "FP recognized",
              value: fp_revenue,
              dim: fp_revenue === 0,
            },
            {
              kind: "subtotal",
              label: "Total revenue",
              value: total_revenue,
            },
            { kind: "gap" },
            { kind: "section", label: "Cost" },
            {
              kind: "line",
              label: "Payroll allocated to projects",
              value: allocated_cost,
            },
            { kind: "line", label: "Payroll bench", value: bench_cost },
            {
              kind: "line",
              label: "Freelancers",
              value: freelancer_cost,
              dim: freelancer_cost === 0,
            },
            { kind: "subtotal", label: "Total cost", value: total_cost },
            { kind: "gap" },
            {
              kind: "total",
              label: "Operating result",
              value: operating_result,
              tone: opTone,
            },
            {
              kind: "total_pct",
              label: "Operating margin",
              value: operating_margin_pct,
              tone: opTone,
            },
          ]}
        />
        <div className="space-y-1 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          {delta_margin !== null && (
            <div>
              <span className="font-medium">
                Δ vs {monthLabel(priorMonth)}:
              </span>{" "}
              <span
                className={cn(
                  "tabular-nums",
                  delta_margin > 0
                    ? "text-emerald-700"
                    : delta_margin < 0
                      ? "text-red-700"
                      : "",
                )}
              >
                {delta_margin > 0 ? "↑" : delta_margin < 0 ? "↓" : "·"}{" "}
                {formatEUR(Math.abs(delta_margin).toFixed(2))} margin
              </span>
              {delta_margin_pct_pp !== null && (
                <>
                  <span className="mx-1">·</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      delta_margin_pct_pp > 0
                        ? "text-emerald-700"
                        : delta_margin_pct_pp < 0
                          ? "text-red-700"
                          : "",
                    )}
                  >
                    {delta_margin_pct_pp >= 0 ? "+" : ""}
                    {delta_margin_pct_pp.toFixed(1)} pp
                  </span>
                </>
              )}
            </div>
          )}
          <div>
            <Link
              href="/reports/utilization"
              className="hover:text-foreground hover:underline"
            >
              Bench &amp; utilization breakdown →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function opTone_(result: number): "positive" | "negative" | null {
  if (result > 0) return "positive";
  if (result < 0) return "negative";
  return null;
}

type PLRow =
  | { kind: "section"; label: string }
  | { kind: "line"; label: string; value: number; dim?: boolean }
  | { kind: "subtotal"; label: string; value: number }
  | { kind: "gap" }
  | {
      kind: "total";
      label: string;
      value: number;
      tone: "positive" | "negative" | null;
    }
  | {
      kind: "total_pct";
      label: string;
      value: number | null;
      tone: "positive" | "negative" | null;
    };

function PLTable({ rows }: { rows: PLRow[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r, i) => {
          if (r.kind === "gap") {
            return (
              <tr key={i} aria-hidden>
                <td className="h-2" />
                <td className="h-2" />
              </tr>
            );
          }
          if (r.kind === "section") {
            return (
              <tr key={i}>
                <td
                  colSpan={2}
                  className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {r.label}
                </td>
              </tr>
            );
          }
          if (r.kind === "line") {
            return (
              <tr key={i}>
                <td
                  className={cn(
                    "px-4 py-1 pl-8",
                    r.dim && "text-muted-foreground",
                  )}
                >
                  {r.label}
                </td>
                <td
                  className={cn(
                    "px-4 py-1 text-right tabular-nums",
                    r.dim && "text-muted-foreground",
                  )}
                >
                  {formatEUR(r.value.toFixed(2))}
                </td>
              </tr>
            );
          }
          if (r.kind === "subtotal") {
            return (
              <tr key={i} className="border-t">
                <td className="px-4 py-1 pl-8 font-medium">{r.label}</td>
                <td className="px-4 py-1 text-right font-medium tabular-nums">
                  {formatEUR(r.value.toFixed(2))}
                </td>
              </tr>
            );
          }
          if (r.kind === "total") {
            return (
              <tr key={i} className="border-t-2 border-foreground/30">
                <td className="px-4 py-2 text-base font-semibold">
                  {r.label}
                </td>
                <td
                  className={cn(
                    "px-4 py-2 text-right text-base font-semibold tabular-nums",
                    r.tone === "positive" && "text-emerald-700",
                    r.tone === "negative" && "text-red-700",
                  )}
                >
                  {r.value >= 0 ? "" : "−"}
                  {formatEUR(Math.abs(r.value).toFixed(2))}
                </td>
              </tr>
            );
          }
          // total_pct
          return (
            <tr key={i}>
              <td className="px-4 py-1 text-sm font-medium">{r.label}</td>
              <td
                className={cn(
                  "px-4 py-1 text-right text-sm font-medium tabular-nums",
                  r.tone === "positive" && "text-emerald-700",
                  r.tone === "negative" && "text-red-700",
                )}
              >
                {r.value === null ? "—" : `${r.value.toFixed(1)}%`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Per-project P&L
// ---------------------------------------------------------------------------

function ProjectPLBlock({ data }: { data: PortfolioMonthly }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Per-project P&amp;L
      </h3>
      <ProjectTable rows={data.projects} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// FP context — collapsible disclosure with lifetime P&L + over-budget summary
// ---------------------------------------------------------------------------

function FpContext({ data }: { data: PortfolioMonthly }) {
  // No FP activity → no section.
  if (
    data.n_fp_projects === 0 &&
    !data.fp_cumulative_recognized &&
    data.fp_n_over_budget === 0
  ) {
    return null;
  }
  const lifetime_recognized = data.fp_cumulative_recognized
    ? Number(data.fp_cumulative_recognized)
    : null;
  const lifetime_cost = data.fp_cumulative_cost
    ? Number(data.fp_cumulative_cost)
    : null;
  const lifetime_margin = data.fp_cumulative_margin
    ? Number(data.fp_cumulative_margin)
    : null;
  const lifetime_margin_pct =
    data.fp_cumulative_margin_pct == null
      ? null
      : Number(data.fp_cumulative_margin_pct);
  const lifetimeTone =
    lifetime_margin === null
      ? ""
      : lifetime_margin >= 0
        ? "text-emerald-700"
        : "text-red-700";

  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Fixed-price context
      </h3>
      <div className="space-y-2 rounded-md border bg-background p-3">
        {data.fp_n_over_budget > 0 && (
          <p className="text-sm">
            <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">
              ⚠ {data.fp_n_over_budget} over budget
            </span>{" "}
            <span className="text-muted-foreground">
              — projects whose tracked hours exceeded the time budget;
              recognized revenue is capped at the agreed amount.
            </span>
          </p>
        )}
        {lifetime_recognized !== null && (
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              <span className="select-none">▸</span>
              <span className="ml-1 group-open:hidden">
                Show lifetime FP P&amp;L
              </span>
              <span className="ml-1 hidden group-open:inline">
                Hide lifetime FP P&amp;L
              </span>
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              <FpTile
                label="Cumulative recognized"
                value={formatEUR(lifetime_recognized.toFixed(2))}
              />
              <FpTile
                label="Cumulative cost"
                value={
                  lifetime_cost === null
                    ? "—"
                    : formatEUR(lifetime_cost.toFixed(2))
                }
              />
              <FpTile
                label="Cumulative margin"
                value={
                  lifetime_margin === null
                    ? "—"
                    : `${lifetime_margin >= 0 ? "" : "−"}${formatEUR(
                        Math.abs(lifetime_margin).toFixed(2),
                      )}`
                }
                tone={lifetimeTone}
              />
              <FpTile
                label="Cumulative margin %"
                value={
                  lifetime_margin_pct === null
                    ? "—"
                    : `${lifetime_margin_pct.toFixed(1)}%`
                }
                tone={lifetimeTone}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Per-month FP is volatile (recognition lumps); the lifetime
              cumulative numbers are the honest read on FP health.
            </p>
          </details>
        )}
      </div>
    </section>
  );
}

function FpTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-medium tabular-nums",
          tone,
        )}
      >
        {value}
      </div>
    </div>
  );
}
