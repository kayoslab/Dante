"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi, KpiGrid } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeTeams } from "@/lib/api/employees";
import { useTrackedHours } from "@/lib/api/tracked-hours";
import { isoMonthOf, monthLabel, shiftMonth } from "@/lib/month";

export function TimeClient() {
  const [month, setMonth] = useState<string>(() => isoMonthOf(new Date()));
  const [team, setTeam] = useState<string>("");
  const todayMonth = isoMonthOf(new Date());
  const { data: teams = [] } = useEmployeeTeams();
  const { data, isLoading, isError, error } = useTrackedHours(
    month,
    team || undefined,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Time tracking</h1>
          <p className="text-sm text-muted-foreground">
            Actual tracked time per consultant (Personio + awork), split into
            billable vs. non-billable / untagged internal time. For people who
            track in awork, awork wins and their duplicate Personio placeholder
            time is excluded. (This is booked time; unused capacity &mdash;
            bench &mdash; lives in the Forecast report.)
          </p>
        </div>
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

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{monthLabel(month)}</CardTitle>
            {data && (
              <span className="text-sm text-muted-foreground">
                {data.working_days_in_month} working days · {data.n_consultants}{" "}
                consultants logged time
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {isLoading && <Skeleton className="h-40 w-full" />}
          {isError && (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load"}
            </p>
          )}
          {data && (
            <>
              <KpiRow data={data} />
              <ConsultantTable rows={data.consultants} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiRow({ data }: { data: ReturnType<typeof useTrackedHours>["data"] & object }) {
  const billablePct =
    data.total_hours > 0
      ? (data.total_billable_hours / data.total_hours) * 100
      : 0;
  const avail = data.total_available_hours ?? 0;
  const billableUtilPct =
    avail > 0 ? (data.total_billable_hours / avail) * 100 : null;
  return (
    <KpiGrid>
      <Kpi
        label="Available"
        value={avail > 0 ? `${avail.toLocaleString()}h` : "—"}
        sub="contract − absences, full month"
        emphasize
      />
      <Kpi
        label="Billable util"
        value={billableUtilPct === null ? "—" : `${billableUtilPct.toFixed(1)}%`}
        sub="billable ÷ available"
        tone={
          billableUtilPct === null
            ? undefined
            : billableUtilPct >= 70
              ? "positive"
              : "negative"
        }
        emphasize
      />
      <Kpi
        label="Total hours"
        value={`${data.total_hours.toLocaleString()}h`}
        emphasize
      />
      <Kpi
        label="Billable"
        value={`${data.total_billable_hours.toLocaleString()}h`}
        sub={`${billablePct.toFixed(0)}% of tracked`}
        tone="positive"
        emphasize
      />
      <Kpi
        label="Non-billable"
        value={`${data.total_non_billable_hours.toLocaleString()}h`}
        sub="Internal / non-billable projects"
        tone="amber"
        emphasize
      />
      <Kpi
        label="Untagged"
        value={`${data.total_untagged_hours.toLocaleString()}h`}
        sub="No project on entry"
        tone="muted"
        emphasize
      />
    </KpiGrid>
  );
}

function ConsultantTable({ rows }: { rows: import("@/lib/api/tracked-hours").ConsultantTrackedHoursRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No consultants logged time in this period (with the current filters).
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Consultant</th>
            <th className="px-3 py-2 text-left font-medium">Team</th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Hours this person could work this month: contract working days × daily hours (weekly hours ÷ 5), minus absences. Holidays per office state; Personio half-days count 0.5. Full month, regardless of today."
            >
              Available
            </th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Tracked on a billable project. awork-tracked days take precedence over duplicate Personio placeholders."
            >
              Billable
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Realized billable utilization: billable tracked hours ÷ available hours."
            >
              Util %
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Tracked on a non-billable / internal project (e.g. Interne Tätigkeit) — internal time, not billed."
            >
              Non-billable
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Personio attendance without a project — untagged internal time (awork-tracked days are excluded)."
            >
              Untagged
            </th>
            <th className="px-3 py-2 text-right font-medium">Mix</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((c) => {
            const tot = c.total_hours || 1;
            const bPct = (c.billable_hours / tot) * 100;
            const nbPct = (c.non_billable_hours / tot) * 100;
            return (
              <tr key={c.employee_id} className="hover:bg-muted/20">
                <td className="px-3 py-2">
                  <Link
                    href={`/employees/${c.employee_id}`}
                    className="font-medium hover:underline"
                  >
                    {c.first_name} {c.last_name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {c.team ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {c.available_hours !== undefined && c.available_hours > 0
                    ? `${c.available_hours}h`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">
                  {c.total_hours}h
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                  {c.billable_hours > 0 ? `${c.billable_hours}h` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {c.available_hours !== undefined && c.available_hours > 0
                    ? `${((c.billable_hours / c.available_hours) * 100).toFixed(0)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                  {c.non_billable_hours > 0 ? `${c.non_billable_hours}h` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {c.untagged_hours > 0 ? `${c.untagged_hours}h` : "—"}
                </td>
                <td className="px-3 py-2">
                  <MixBar billable={bPct} unmapped={nbPct} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MixBar({ billable, unmapped }: { billable: number; unmapped: number }) {
  // `unmapped` = the non-billable share; kept the prop name to avoid churn.
  // Emerald = billable, amber = non-billable, remainder (untagged) shows as the
  // muted track behind.
  return (
    <div className="flex h-2 w-24 overflow-hidden rounded-full bg-muted">
      <div
        className="bg-emerald-500"
        style={{ width: `${billable}%` }}
        title={`billable ${billable.toFixed(0)}%`}
      />
      <div
        className="bg-amber-500"
        style={{ width: `${unmapped}%` }}
        title={`non-billable ${unmapped.toFixed(0)}%`}
      />
    </div>
  );
}
