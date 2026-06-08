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
            Personio attendance per consultant, split by how the time was
            tagged. Untagged hours are typically Security Testing (no project
            field) — they&apos;ll move to <em>billable</em> once awork
            integration ships.
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
  return (
    <KpiGrid>
      <Kpi
        label="Total hours"
        value={`${data.total_hours.toLocaleString()}h`}
        emphasize
      />
      <Kpi
        label="Billable"
        value={`${data.total_billable_hours.toLocaleString()}h`}
        sub={`${billablePct.toFixed(0)}% of total`}
        tone="positive"
        emphasize
      />
      <Kpi
        label="Unmapped tagged"
        value={`${data.total_unmapped_hours.toLocaleString()}h`}
        sub="Personio project but not mapped"
        tone="amber"
        emphasize
      />
      <Kpi
        label="Untagged"
        value={`${data.total_untagged_hours.toLocaleString()}h`}
        sub="No Personio project on entry"
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
            <th className="px-3 py-2 text-right font-medium">Total</th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Logged on a Personio project that's mapped to one of our T&M projects."
            >
              Billable
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Logged on a Personio project that isn't mapped (e.g. Interne Tätigkeit)."
            >
              Unmapped
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Attendance entries without a Personio project (Security Testing pattern)."
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
            const uPct = (c.unmapped_hours / tot) * 100;
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
                <td className="px-3 py-2 text-right tabular-nums font-medium">
                  {c.total_hours}h
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                  {c.billable_hours > 0 ? `${c.billable_hours}h` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                  {c.unmapped_hours > 0 ? `${c.unmapped_hours}h` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {c.untagged_hours > 0 ? `${c.untagged_hours}h` : "—"}
                </td>
                <td className="px-3 py-2">
                  <MixBar billable={bPct} unmapped={uPct} />
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
        title={`unmapped ${unmapped.toFixed(0)}%`}
      />
    </div>
  );
}
