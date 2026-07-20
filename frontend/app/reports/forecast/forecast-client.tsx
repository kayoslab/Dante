"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type CapacityBreakdown,
  type CapacityBucket,
  type ForecastConsultantRow,
  type ForecastReport,
  type ForecastRow,
  useForecast,
} from "@/lib/api/forecast";
import { monthLabel } from "@/lib/month";
import { cn } from "@/lib/utils";

const NO_TEAM = "(no team)";
const NO_TIER = "(unset)";

function fmtH(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${n.toFixed(1)}h`;
}
function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${n.toFixed(0)}%`;
}

/** Utilization: high is good. */
function utilTone(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 80) return "text-emerald-700";
  if (pct >= 60) return "text-amber-700";
  return "text-red-700";
}
/** Bench: high is bad. */
function benchTone(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct <= 10) return "text-emerald-700";
  if (pct <= 25) return "text-amber-700";
  return "text-red-700";
}

/** Client half of the Forecast report. One fetch drives everything; owns
 * only the expand/collapse state for the per-group consultant drill-down. */
export function ForecastClient() {
  const { data, isLoading, isError } = useForecast();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Forecast</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Billable delivery against available capacity. Utilization compares
          hours booked on <strong>billable</strong> projects to each
          team&rsquo;s available capacity (contract hours minus paid absence).
          Bench is unused capacity &mdash; time neither planned onto work nor
          spent on billable delivery. Internal / non-billable time (meetings,
          research, travel) is shown for context but never counts as delivery.
          Current-month actuals are month-to-date.
        </p>
      </div>

      {isLoading && !data ? (
        <Skeleton className="h-64 w-full" />
      ) : isError || !data ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Couldn&rsquo;t load the forecast. Try again.
          </CardContent>
        </Card>
      ) : (
        <ForecastBody data={data} />
      )}
    </div>
  );
}

function ForecastBody({ data }: { data: ForecastReport }) {
  const { totals, by_team, by_role_tier, by_consultant, current_month } = data;

  const pipeline = [
    { month: current_month, planned: totals.planned_billable_h, available: totals.available_h },
    ...totals.next.map((m) => ({
      month: m.month,
      planned: m.planned_billable_h,
      available: m.available_h,
    })),
  ];

  return (
    <>
      <KpiGrid>
        <Kpi
          label={`Available · ${monthLabel(current_month)}`}
          value={fmtH(totals.available_h)}
          sub={`${fmtH(totals.capacity_h)} capacity − ${fmtH(totals.vacation_h)} absence`}
        />
        <Kpi
          label="Billable utilization"
          value={fmtPct(totals.utilization_pct)}
          tone={
            totals.utilization_pct === null
              ? null
              : totals.utilization_pct >= 70
                ? "positive"
                : "negative"
          }
          hint="billable hours booked ÷ available capacity (month-to-date)"
        />
        <Kpi
          label="Bench"
          value={fmtH(totals.bench_h)}
          sub={`${fmtPct(totals.bench_pct)} of available`}
          tone={
            totals.bench_pct === null
              ? null
              : totals.bench_pct <= 15
                ? "positive"
                : "negative"
          }
        />
        <Kpi
          label="Delivery vs plan"
          value={fmtPct(totals.delivery_pct)}
          hint="billable booked ÷ billable planned, both to today"
        />
      </KpiGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Billable pipeline</CardTitle>
          <p className="text-xs text-muted-foreground">
            Planned billable hours for the current month and the next two, with
            each month&rsquo;s available capacity beneath (→ planned
            utilization).
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {pipeline.map((p) => {
            const plannedUtil =
              p.available > 0 ? Math.round((p.planned / p.available) * 100) : null;
            return (
              <div key={p.month} className="rounded-md border bg-background p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {monthLabel(p.month)}
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {fmtH(p.planned)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {fmtH(p.available)} available
                  {plannedUtil !== null && ` · ${plannedUtil}% planned`}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <CapacitySection capacity={data.capacity} />

      <RollupSection
        title="Per team"
        rows={by_team}
        consultants={by_consultant}
        axis="team"
        nextMonths={data.next_months}
      />
      <RollupSection
        title="Per role tier"
        rows={by_role_tier}
        consultants={by_consultant}
        axis="role_tier"
        nextMonths={data.next_months}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Rollup table with expandable per-consultant drill-down
// ---------------------------------------------------------------------------

function RollupSection({
  title,
  rows,
  consultants,
  axis,
  nextMonths,
}: {
  title: string;
  rows: ForecastRow[];
  consultants: ForecastConsultantRow[];
  axis: "team" | "role_tier";
  nextMonths: string[];
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const childrenOf = (key: string): ForecastConsultantRow[] => {
    const sentinel = axis === "team" ? NO_TEAM : NO_TIER;
    return consultants.filter((c) => {
      const v = axis === "team" ? c.team : c.role_tier;
      return key === sentinel ? v === null : v === key;
    });
  };

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No data.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Billable delivery vs available, current month. Click a row to see its
          consultants.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  {axis === "team" ? "Team" : "Role tier"}
                </th>
                <th className="px-3 py-2 text-right font-medium">HC</th>
                <th className="px-3 py-2 text-right font-medium">Avail.</th>
                <th className="px-3 py-2 text-right font-medium">Planned·b</th>
                <th className="px-3 py-2 text-right font-medium">Actual·b</th>
                <th className="px-3 py-2 text-right font-medium">Util%</th>
                <th className="px-3 py-2 text-right font-medium">Bench</th>
                {nextMonths.map((m) => (
                  <th key={m} className="px-3 py-2 text-right font-medium">
                    {monthLabel(m)}·b
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const kids = childrenOf(r.key);
                const expanded = open.has(r.key);
                const canExpand = kids.length > 0;
                return (
                  <Fragment key={r.key}>
                    <tr
                      className={cn(
                        "hover:bg-muted/20",
                        canExpand && "cursor-pointer",
                      )}
                      onClick={canExpand ? () => toggle(r.key) : undefined}
                    >
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1">
                          {canExpand ? (
                            expanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )
                          ) : (
                            <span className="w-3.5" />
                          )}
                          {r.key}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.n_employees}
                      </td>
                      <RowMetrics r={r} />
                    </tr>
                    {expanded &&
                      kids.map((c) => (
                        <tr key={c.employee_id} className="bg-muted/10">
                          <td className="px-3 py-1.5 pl-8">
                            <Link
                              href={`/employees/${c.employee_id}`}
                              className="hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {c.who_name}
                            </Link>
                          </td>
                          <td />
                          <RowMetrics r={c} muted />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/** Metric cells shared by group rows and consultant sub-rows: available,
 * planned billable, actual billable, utilization %, bench, then each future
 * month's planned billable. */
function RowMetrics({ r, muted }: { r: ForecastRow; muted?: boolean }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{fmtH(r.available_h)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {fmtH(r.planned_billable_h)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {fmtH(r.actual_billable_h)}
        {r.actual_nonbillable_h > 0 && (
          <span className="ml-1 text-xs text-muted-foreground">
            (+{r.actual_nonbillable_h.toFixed(0)} int)
          </span>
        )}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums",
          muted ? "text-muted-foreground" : utilTone(r.utilization_pct),
        )}
      >
        {fmtPct(r.utilization_pct)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums",
          muted ? "text-muted-foreground" : benchTone(r.bench_pct),
        )}
      >
        {fmtH(r.bench_h)}
        <span className="ml-1 text-xs text-muted-foreground">
          ({fmtPct(r.bench_pct)})
        </span>
      </td>
      {r.next.map((m) => (
        <td key={m.month} className="px-3 py-2 text-right tabular-nums">
          {fmtH(m.planned_billable_h)}
        </td>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Capacity breakdown — where a team's paid capacity goes, per month.
// Billable delivered + Allocated·not-billed + Bench + Vacation = capacity;
// Over-allocation is flagged separately.
// ---------------------------------------------------------------------------

type CapUnit = "hours" | "fte" | "pct";

/** Format one bucket in the selected unit. Hours = raw; FTE denominator is a
 * full-timer's month (working_days × 8h); % is the bucket's share of total
 * capacity (`base_h`) — so every column shares one base. */
function capValue(
  unit: CapUnit,
  value_h: number,
  base_h: number,
  working_days: number,
): string {
  if (unit === "hours") return `${value_h.toFixed(0)}h`;
  if (unit === "fte")
    return working_days > 0 ? (value_h / (working_days * 8)).toFixed(2) : "—";
  return base_h > 0 ? `${Math.round((value_h / base_h) * 100)}%` : "—";
}

const CAP_COLS = [
  { key: "billable", label: "Billable", cls: "text-emerald-700", title: "Capacity on billable work — planned billable allocation (raised by any billable delivery beyond the plan)." },
  { key: "internal", label: "Non-bill", cls: "text-violet-700", title: "Capacity planned on non-billable / internal projects." },
  { key: "bench", label: "Bench", cls: "text-amber-700", title: "Unused capacity — neither planned onto work nor covered by billable delivery." },
  { key: "vac", label: "Vac", cls: "text-sky-700", title: "Paid vacation / absence (outside available)." },
  { key: "over", label: "Over", cls: "text-red-700", title: "Allocated or delivered beyond FULL capacity (over-allocation / overtime)." },
] as const;

function capCell(
  col: (typeof CAP_COLS)[number]["key"],
  b: CapacityBucket,
  unit: CapUnit,
  wd: number,
): string {
  const base = b.capacity_h;
  switch (col) {
    case "billable":
      return capValue(unit, b.on_project_billable_h, base, wd);
    case "internal":
      return b.on_project_nonbillable_h > 0
        ? capValue(unit, b.on_project_nonbillable_h, base, wd)
        : "—";
    case "bench":
      return capValue(unit, b.bench_h, base, wd);
    case "vac":
      return b.vacation_h > 0 ? capValue(unit, b.vacation_h, base, wd) : "—";
    case "over":
      return b.over_h > 0 ? capValue(unit, b.over_h, base, wd) : "—";
  }
}

function CapacitySection({ capacity }: { capacity: CapacityBreakdown }) {
  const [unit, setUnit] = useState<CapUnit>("pct");
  const rows = [capacity.totals, ...capacity.by_team];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Capacity breakdown</CardTitle>
            <p className="text-xs text-muted-foreground">
              Where each team&rsquo;s paid capacity goes. <strong>Billable +
              Non-bill + Bench + Vacation = 100%</strong> of capacity;
              <strong> Over</strong> flags allocation/delivery beyond full
              capacity. The billable / non-billable split is based on the
              <em> planned</em> allocation (so it reflects the real project mix
              in the current and future months); actual billable delivery only
              raises billable when it exceeds the plan. <strong>Bench</strong>
              is unused capacity. FTE: 1.0 = one full-timer (40h/wk) for the
              month.
            </p>
          </div>
          <div className="inline-flex rounded-md border bg-background p-0.5 text-xs">
            {(["pct", "hours", "fte"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={cn(
                  "rounded px-2.5 py-1 font-medium",
                  unit === u
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {u === "hours" ? "Hours" : u === "fte" ? "FTE" : "%"}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th
                  rowSpan={2}
                  className="px-3 py-2 text-left align-bottom font-medium"
                >
                  Team
                </th>
                {capacity.months.map((m) => (
                  <th
                    key={m.month}
                    colSpan={CAP_COLS.length}
                    className="border-l px-3 py-1.5 text-center font-medium"
                  >
                    {monthLabel(m.month)}
                  </th>
                ))}
              </tr>
              <tr>
                {capacity.months.map((m) => (
                  <Fragment key={m.month}>
                    {CAP_COLS.map((col, ci) => (
                      <th
                        key={col.key}
                        className={cn(
                          "px-3 py-1 text-right font-medium",
                          ci === 0 && "border-l",
                          col.cls,
                        )}
                        title={col.title}
                      >
                        {col.label}
                      </th>
                    ))}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const isTotal = r.key === "__total__";
                return (
                  <tr
                    key={r.key}
                    className={cn(
                      "hover:bg-muted/20",
                      isTotal && "bg-muted/10 font-medium",
                    )}
                  >
                    <td className="px-3 py-2">
                      {isTotal ? "All teams" : r.key}
                    </td>
                    {r.months.map((b, i) => {
                      const wd = capacity.months[i].working_days;
                      return (
                        <Fragment key={capacity.months[i].month}>
                          {CAP_COLS.map((col, ci) => (
                            <td
                              key={col.key}
                              className={cn(
                                "px-3 py-2 text-right tabular-nums",
                                ci === 0 && "border-l",
                                col.cls,
                                (col.key === "vac" && b.vacation_h === 0) ||
                                  (col.key === "over" && b.over_h === 0) ||
                                  (col.key === "internal" &&
                                    b.on_project_nonbillable_h === 0)
                                  ? "text-muted-foreground"
                                  : undefined,
                              )}
                            >
                              {capCell(col.key, b, unit, wd)}
                            </td>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <CapacityBars
          rows={capacity.by_team}
          monthLabelText={monthLabel(capacity.months[0]?.month ?? "")}
        />
      </CardContent>
    </Card>
  );
}

/** Stacked bar per team for the current month: Billable / Alloc·NB / Bench /
 * Vacation as % of total capacity. Over-allocation is flagged with a red ring
 * + "+X%" rather than overflowing the track. */
function CapacityBars({
  rows,
  monthLabelText,
}: {
  rows: CapacityBreakdown["by_team"];
  monthLabelText: string;
}) {
  const withData = rows
    .map((r) => ({ key: r.key, b: r.months[0] }))
    .filter((r) => r.b && r.b.capacity_h > 0);
  if (withData.length === 0) return null;

  const seg = (h: number, cap: number) => (cap > 0 ? (h / cap) * 100 : 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {monthLabelText} · capacity mix
        </h4>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <Legend cls="bg-emerald-500" label="Billable" />
          <Legend cls="bg-violet-400" label="Non-bill" />
          <Legend cls="bg-amber-400" label="Bench" />
          <Legend cls="bg-sky-300" label="Vacation" />
        </div>
      </div>
      <div className="space-y-1.5">
        {withData.map(({ key, b }) => {
          const cap = b!.capacity_h;
          const billW = seg(b!.on_project_billable_h, cap);
          const internalW = seg(b!.on_project_nonbillable_h, cap);
          const benchW = seg(b!.bench_h, cap);
          const vacW = seg(b!.vacation_h, cap);
          const overPct = Math.round(seg(b!.over_h, cap));
          const parts = [
            { w: billW, cls: "bg-emerald-500" },
            { w: internalW, cls: "bg-violet-400" },
            { w: benchW, cls: "bg-amber-400" },
            { w: vacW, cls: "bg-sky-300" },
          ];
          return (
            <div key={key} className="flex items-center gap-2">
              <div className="w-40 shrink-0 truncate text-xs" title={key}>
                {key}
              </div>
              <div
                className={cn(
                  "h-4 flex-1 overflow-hidden rounded-sm bg-muted/60",
                  overPct > 0 && "ring-1 ring-red-500",
                )}
              >
                <div className="flex h-full w-full">
                  {parts.map((p, idx) => (
                    <div
                      key={idx}
                      className={cn("h-full shrink-0", p.cls)}
                      style={{ width: `${p.w}%` }}
                    />
                  ))}
                </div>
              </div>
              <div className="w-16 shrink-0 text-right text-xs tabular-nums">
                {overPct > 0 ? (
                  <span className="text-red-700" title="Over capacity">
                    +{overPct}%
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", cls)} />
      {label}
    </span>
  );
}
