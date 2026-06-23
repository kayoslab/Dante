"use client";

import Link from "next/link";
import { AlertTriangle, TrendingDown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TeamUpcomingAssignment } from "@/lib/db/queries/team";

/** "Ending soon" + "Going partial" callouts derived from the same
 * `getTeamUpcomingAssignments` query the page already fetched. Pure
 * presentation: no extra DB round-trip.
 *
 * "Ending soon" = assignment whose `end_date` falls inside the
 * forecast window. Listed in date order.
 *
 * "Going partial" = an employee whose total allocation drops by
 * `partialThresholdPct` or more between today and the window's end.
 * Detected by re-aggregating per-employee allocation at the start and
 * at the end of the window.
 */
export function TeamForecastSection({
  upcoming,
  today,
  forecastEnd,
  partialThresholdPct,
}: {
  upcoming: TeamUpcomingAssignment[];
  today: string;
  forecastEnd: string;
  partialThresholdPct: number;
}) {
  // Ending-soon list: end_date inside the window, sorted by end_date ASC.
  const endingSoon = upcoming
    .filter(
      (u) => u.end_date !== null && u.end_date >= today && u.end_date <= forecastEnd,
    )
    .sort((a, b) => (a.end_date ?? "").localeCompare(b.end_date ?? ""));

  // Going-partial detection: per-employee summed allocation at `today`
  // vs at `forecastEnd`. An employee whose total allocation drops by
  // ≥ partialThresholdPct flags. Bench-going-to-bench doesn't flag
  // (no change); fully-allocated-going-to-partial does.
  const allocAt = (date: string) => {
    const m = new Map<number, { total: number; who_name: string }>();
    for (const u of upcoming) {
      const startsBefore = u.start_date === null || u.start_date <= date;
      const endsAfter = u.end_date === null || u.end_date >= date;
      if (!startsBefore || !endsAfter) continue;
      const cur = m.get(u.employee_id) ?? { total: 0, who_name: u.who_name };
      cur.total += Number(u.allocation_pct);
      m.set(u.employee_id, cur);
    }
    return m;
  };
  const start = allocAt(today);
  const end = allocAt(forecastEnd);
  type PartialRow = {
    employee_id: number;
    who_name: string;
    drop_pct: number;
    from_pct: number;
    to_pct: number;
  };
  const goingPartial: PartialRow[] = [];
  for (const [employee_id, s] of start) {
    const e = end.get(employee_id) ?? { total: 0, who_name: s.who_name };
    const drop = (s.total - e.total) * 100;
    if (drop >= partialThresholdPct) {
      goingPartial.push({
        employee_id,
        who_name: s.who_name,
        drop_pct: drop,
        from_pct: s.total * 100,
        to_pct: e.total * 100,
      });
    }
  }
  goingPartial.sort((a, b) => b.drop_pct - a.drop_pct);

  if (endingSoon.length === 0 && goingPartial.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Forecast (next 90 days)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No assignments ending or stepping down between {today} and{" "}
            {forecastEnd}. Coverage stays where it is today across the
            committed assignment book.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Forecast (next 90 days)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {endingSoon.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-700">
              <AlertTriangle className="size-3.5" /> Ending soon
            </div>
            <div className="overflow-x-auto rounded-md border bg-background">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Project</th>
                    <th className="px-3 py-2 text-left font-medium">Profile</th>
                    <th className="px-3 py-2 text-right font-medium">End</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {endingSoon.map((a) => (
                    <tr key={a.assignment_id} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <Link
                          href={`/employees/${a.employee_id}`}
                          className="hover:underline"
                        >
                          {a.who_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/projects/${a.project_id}`}
                          className="hover:underline"
                        >
                          {a.customer_name} / {a.project_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.profile ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.end_date}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {goingPartial.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-700">
              <TrendingDown className="size-3.5" /> Going partial
              <span className="ml-1 text-[10px] font-normal normal-case text-muted-foreground">
                (allocation drops ≥ {partialThresholdPct} pp)
              </span>
            </div>
            <div className="overflow-x-auto rounded-md border bg-background">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Now
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {forecastEnd}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Drop</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {goingPartial.map((r) => (
                    <tr key={r.employee_id} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <Link
                          href={`/employees/${r.employee_id}`}
                          className="hover:underline"
                        >
                          {r.who_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.from_pct.toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.to_pct.toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                        −{r.drop_pct.toFixed(0)} pp
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
