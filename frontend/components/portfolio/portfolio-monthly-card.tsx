"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePortfolioMonthly,
  type PortfolioProjectRow,
} from "@/lib/api/portfolio";
import { formatEUR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";
import { Kpi, KpiGrid } from "@/components/ui/kpi";

export function PortfolioMonthlyCard() {
  const [month, setMonth] = useState<string>(() => isoMonthOf(new Date()));
  const { data, isLoading, isError, error } = usePortfolioMonthly(month);
  const todayMonth = isoMonthOf(new Date());

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Portfolio rentability</CardTitle>
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
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{monthLabel(month)}</span>
          {data && (
            <>
              <span>·</span>
              <span>{data.working_days_in_month} working days</span>
              <span>·</span>
              <span>
                {data.n_active_projects} active projects ({data.n_tm_projects} T&M
                {data.n_fp_projects > 0 ? `, ${data.n_fp_projects} FP` : ""})
              </span>
            </>
          )}
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
            <KpiRow data={data} />
            <BenchSection bench={data.bench} />
            <ProjectTable rows={data.projects} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function KpiRow({ data }: { data: NonNullable<ReturnType<typeof usePortfolioMonthly>["data"]> }) {
  const tmMargin = Number(data.tm_margin);
  const tmTone = tmMargin >= 0 ? "positive" : "negative";
  const fpRemaining = data.fp_remaining_budget ? Number(data.fp_remaining_budget) : null;
  const fpTone = fpRemaining === null ? null : fpRemaining >= 0 ? "positive" : "negative";
  const totalMargin =
    data.total_margin != null ? Number(data.total_margin) : null;
  const totalTone =
    totalMargin == null ? null : totalMargin >= 0 ? "positive" : "negative";
  const fpRecMargin =
    data.fp_recognized_margin != null ? Number(data.fp_recognized_margin) : null;
  const fpRecTone =
    fpRecMargin == null ? null : fpRecMargin >= 0 ? "positive" : "negative";
  const fpCumMargin =
    data.fp_cumulative_margin != null ? Number(data.fp_cumulative_margin) : null;
  const fpCumTone =
    fpCumMargin == null ? null : fpCumMargin >= 0 ? "positive" : "negative";

  return (
    <div className="space-y-4">
      {data.total_revenue != null && (
        <section className="rounded-md border bg-muted/30 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Portfolio total (T&amp;M + FP recognized)
          </h3>
          <KpiGrid>
            <Kpi label="Revenue" value={formatEUR(data.total_revenue)} />
            <Kpi label="Cost" value={formatEUR(data.total_cost)} />
            <Kpi
              label="Margin"
              value={formatEUR(data.total_margin)}
              tone={totalTone}
            />
            <Kpi
              label="Margin %"
              value={formatPercent(data.total_margin_pct)}
              tone={totalTone}
            />
          </KpiGrid>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Time & material
        </h3>
        <KpiGrid>
          <Kpi label="Revenue" value={formatEUR(data.tm_revenue)} />
          <Kpi label="Cost" value={formatEUR(data.tm_cost)} />
          <Kpi label="Margin" value={formatEUR(data.tm_margin)} tone={tmTone} />
          <Kpi
            label="Margin %"
            value={formatPercent(data.tm_margin_pct)}
            tone={tmTone}
          />
        </KpiGrid>
      </section>
      {data.n_fp_projects > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Fixed price
          </h3>
          <KpiGrid>
            <Kpi
              label="Agreed total"
              value={
                data.fp_agreed_amount ? formatEUR(data.fp_agreed_amount) : "—"
              }
            />
            <Kpi label="Cost this month" value={formatEUR(data.fp_cost_this_month)} />
            <Kpi label="Cumulative cost" value={formatEUR(data.fp_cumulative_cost)} />
            <Kpi
              label="Remaining budget"
              value={
                data.fp_remaining_budget ? formatEUR(data.fp_remaining_budget) : "—"
              }
              tone={fpTone}
            />
          </KpiGrid>
          {data.fp_recognized_revenue != null && (
            <div className="space-y-3 rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Revenue recognition
                </div>
                {data.fp_n_over_budget > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800"
                    title="FP projects that have burned past their time budget this month. Recognized revenue capped at agreed_amount."
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {data.fp_n_over_budget} over budget
                  </span>
                )}
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Lifetime FP P&amp;L
                </div>
                <KpiGrid>
                  <Kpi
                    label="Cumulative recognized"
                    value={formatEUR(data.fp_cumulative_recognized)}
                  />
                  <Kpi
                    label="Cumulative cost"
                    value={formatEUR(data.fp_cumulative_cost)}
                  />
                  <Kpi
                    label="Cumulative margin"
                    value={formatEUR(data.fp_cumulative_margin)}
                    tone={fpCumTone}
                  />
                  <Kpi
                    label="Cumulative margin %"
                    value={formatPercent(data.fp_cumulative_margin_pct)}
                    tone={fpCumTone}
                  />
                </KpiGrid>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  This month{" "}
                  <span
                    className="ml-1 inline-flex items-center text-muted-foreground/70"
                    title="Per-month FP margin is volatile: cost accrues continuously from allocations × salary, but tracked hours are logged in bursts. A negative current-month margin does NOT mean the portfolio is unprofitable — read the lifetime row above."
                  >
                    ⓘ
                  </span>
                </div>
                <KpiGrid>
                  <Kpi
                    label="Recognized this month"
                    value={formatEUR(data.fp_recognized_revenue)}
                  />
                  <Kpi
                    label="Recognized margin"
                    value={formatEUR(data.fp_recognized_margin)}
                    tone={fpRecTone}
                  />
                  <Kpi
                    label="Recognized margin %"
                    value={formatPercent(data.fp_recognized_margin_pct)}
                    tone={fpRecTone}
                  />
                </KpiGrid>
              </div>
            </div>
          )}
        </section>
      )}
      <div className="border-t pt-3 text-sm">
        <span className="text-muted-foreground">Total operating cost this month: </span>
        <span className="font-semibold tabular-nums">
          {formatEUR(data.total_cost)}
        </span>
      </div>
    </div>
  );
}


function BenchSection({
  bench,
}: {
  bench: NonNullable<ReturnType<typeof usePortfolioMonthly>["data"]>["bench"];
}) {
  const [expanded, setExpanded] = useState(false);
  const pct = bench.total_unallocated_pct
    ? Number(bench.total_unallocated_pct)
    : null;
  // Tone: green if low (<10%), amber medium (10–25%), red high (>25%).
  const tone =
    pct === null
      ? "text-foreground"
      : pct > 25
        ? "text-red-700"
        : pct > 10
          ? "text-amber-700"
          : "text-emerald-700";

  const visible = expanded ? bench.consultants : bench.consultants.slice(0, 5);
  const hiddenCount = bench.consultants.length - visible.length;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Bench / unallocated payroll
      </h3>
      <div className="rounded-md border bg-muted/30 p-3">
        <KpiGrid>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Loaded payroll
            </div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {formatEUR(bench.total_loaded_cost)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Unallocated
            </div>
            <div
              className={cn(
                "mt-0.5 text-base font-semibold tabular-nums",
                tone,
              )}
            >
              {formatEUR(bench.total_unallocated_cost)}
              {pct !== null && (
                <span className="ml-1 text-xs font-normal">
                  ({pct.toFixed(1)}%)
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Bench
            </div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {bench.n_full_bench}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                fully · {bench.n_partial_bench} partial
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Utilized
            </div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {bench.n_fully_utilized}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                consultants
              </span>
            </div>
          </div>
        </KpiGrid>
        {bench.consultants.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Top unallocated EUR
            </div>
            <div className="overflow-x-auto rounded-md border bg-background">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      Consultant
                    </th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Loaded cost
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Util %
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Unallocated
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visible.map((c) => {
                    const u = Number(c.utilization_pct);
                    return (
                      <tr key={c.employee_id} className="hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <Link
                            href={`/employees/${c.employee_id}`}
                            className="hover:underline"
                          >
                            {c.who_name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {c.team ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatEUR(c.monthly_cost)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            u === 0
                              ? "text-red-700"
                              : u < 1
                                ? "text-amber-700"
                                : "text-emerald-700",
                          )}
                        >
                          {(u * 100).toFixed(0)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatEUR(c.unallocated_cost)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="mt-2 text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => setExpanded(true)}
              >
                Show all {bench.consultants.length} consultants
              </button>
            )}
            {expanded && bench.consultants.length > 5 && (
              <button
                type="button"
                className="mt-2 text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => setExpanded(false)}
              >
                Collapse
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ProjectTable({ rows }: { rows: PortfolioProjectRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No projects had active assignments in this month.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Customer / Project</th>
            <th className="px-3 py-2 text-left font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Asgn</th>
            <th className="px-3 py-2 text-right font-medium">Revenue</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 text-right font-medium">Margin</th>
            <th className="px-3 py-2 text-right font-medium">Margin %</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((p) => {
            const margin = p.margin ? Number(p.margin) : null;
            const marginTone =
              margin === null ? null : margin >= 0 ? "text-emerald-700" : "text-red-700";
            const isFp = p.billing_model === "fixed_price";
            const pctComplete =
              p.pct_complete != null ? Number(p.pct_complete) : null;
            const pctLabel =
              pctComplete != null ? `${(pctComplete * 100).toFixed(0)}%` : null;
            return (
              <tr key={p.project_id} className="hover:bg-muted/20">
                <td className="px-3 py-2">
                  <Link
                    href={`/projects/${p.project_id}`}
                    className="hover:underline"
                  >
                    <span className="text-muted-foreground">{p.customer_name}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span>{p.project_name}</span>
                  </Link>
                  {p.over_budget && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800"
                      title={`Burned ${pctLabel ?? "100%+"} of time budget — recognized revenue capped at agreed amount.`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      over
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant="outline"
                    title={
                      isFp && p.recognition_method
                        ? p.recognition_method === "tracked_hours"
                          ? `FP revenue recognized via tracked hours${pctLabel ? ` (${pctLabel} complete)` : ""}`
                          : p.recognition_method === "timeline"
                            ? `FP revenue recognized linearly over planned window${pctLabel ? ` (${pctLabel} elapsed)` : ""}`
                            : "FP — no recognition rule set"
                        : undefined
                    }
                  >
                    {isFp ? "FP" : "T&M"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {p.n_assignments}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {p.revenue ? formatEUR(p.revenue) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatEUR(p.cost)}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", marginTone)}>
                  {p.margin ? formatEUR(p.margin) : "—"}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", marginTone)}>
                  {p.margin_pct ? formatPercent(p.margin_pct) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
