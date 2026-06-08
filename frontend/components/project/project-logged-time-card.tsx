"use client";

import Link from "next/link";
import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryGuard } from "@/components/ui/query-guard";
import { useProjectLoggedTimeSummary } from "@/lib/api/project-logged-time";
import { cn } from "@/lib/utils";

export function ProjectLoggedTimeCard({ projectId }: { projectId: number }) {
  const query = useProjectLoggedTimeSummary(projectId);
  const data = query.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Logged time (lifetime)
          </CardTitle>
          {data && data.n_consultants > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {data.n_consultants} consultant
              {data.n_consultants === 1 ? "" : "s"} ·{" "}
              {data.total_hours.toLocaleString()}h ({Number(data.total_days).toFixed(1)}d)
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <QueryGuard query={query} skeletonHeight="h-32">
          {(data) => data.consultants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No time logged on this project yet. Map a Personio or awork
              project to start collecting tracked hours.
            </p>
          ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Consultant</th>
                  <th className="px-3 py-2 text-left font-medium">Source</th>
                  <th className="px-3 py-2 text-left font-medium">Period</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Days</th>
                  <th className="px-3 py-2 text-right font-medium">Asgn</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.consultants.map((c, i) => (
                  <tr
                    key={c.employee_id ?? `row-${i}`}
                    className="hover:bg-muted/20"
                  >
                    <td className="px-3 py-2">
                      {c.employee_id ? (
                        <Link
                          href={`/employees/${c.employee_id}`}
                          className="hover:underline"
                        >
                          {c.who_name ?? "—"}
                        </Link>
                      ) : (
                        c.who_name ?? "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {c.sources.map((s) => (
                        <span
                          key={s}
                          className="mr-1 inline-flex items-center rounded bg-muted px-1.5 py-0.5"
                        >
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                      {c.first_log_date} → {c.last_log_date}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {c.total_hours.toLocaleString()}h
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {Number(c.total_days).toFixed(1)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums",
                        c.n_assignments === 0 && "text-amber-700",
                      )}
                    >
                      {c.n_assignments === 0 ? (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 text-amber-800"
                        >
                          none
                        </Badge>
                      ) : (
                        c.n_assignments
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              &quot;Asgn&quot; column: number of formal assignment rows for this
              consultant on this project. <span className="text-amber-700">none</span>{" "}
              = they logged time but have no assignment — revenue and cost calculations
              don&apos;t include them yet. Use the &quot;Allocate&quot; button above
              to create an assignment if you want them in the breakdown.
            </p>
          </div>
        )}
        </QueryGuard>
      </CardContent>
    </Card>
  );
}
