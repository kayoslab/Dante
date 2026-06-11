"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useDeleteFreelancerHours,
  useFreelancerHours,
  useSetFreelancerHours,
} from "@/lib/api/freelancer-hours";
import type { ProjectAssignment } from "@/lib/api/projects";

/** Monthly hours-entered grid for freelancer assignments on a project.
 *
 * Rows are freelancer assignments; columns are months from the earliest
 * assignment start to today+2 (capped at 18 months for sanity). A cell
 * is either empty (—) or filled; cells with `source='awork'` show a
 * small pill so the SDM knows they're auto-filled. Manual edits always
 * win — the action upserts with source='manual'.
 *
 * Card is hidden when the project has no freelancer assignments.
 *
 * Display unit is hours; storage is `hours_decimal` (numeric(8,2)). */
export function FreelancerHoursCard({
  projectId,
  assignments,
}: {
  projectId: number;
  assignments: ProjectAssignment[];
}) {
  const freelancers = useMemo(
    () => assignments.filter((a) => a.kind === "freelancer"),
    [assignments],
  );
  const hoursQ = useFreelancerHours(projectId);
  const setHours = useSetFreelancerHours(projectId);
  const delHours = useDeleteFreelancerHours(projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");

  // Column range: from the earliest freelancer start to today + 2 months,
  // capped at 18 months so the grid stays scannable.
  const months = useMemo(() => buildMonthRange(freelancers), [freelancers]);

  if (freelancers.length === 0) return null;

  const byKey = new Map<string, { hours: string; source: "manual" | "awork" }>();
  for (const row of hoursQ.data ?? []) {
    byKey.set(`${row.assignment_id}|${row.year_month}`, {
      hours: row.hours_decimal,
      source: row.source,
    });
  }

  const startEdit = (key: string, currentHours: string | undefined) => {
    setEditing(key);
    setDraft(currentHours ?? "");
  };

  const commit = async (assignment_id: number, year_month: string) => {
    const trimmed = draft.trim();
    const key = `${assignment_id}|${year_month}`;
    setEditing(null);

    if (trimmed === "") {
      // Empty input clears any existing row.
      if (!byKey.has(key)) return;
      try {
        await delHours.mutateAsync({ assignment_id, year_month });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to clear");
      }
      return;
    }

    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Hours must be a number ≥ 0");
      return;
    }
    try {
      await setHours.mutateAsync({
        assignment_id,
        year_month,
        hours_decimal: n,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Freelancer hours</CardTitle>
        <p className="text-xs text-muted-foreground">
          Monthly hours actually worked per freelancer assignment, used
          for profitability. Click a cell to edit. Cells marked{" "}
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wider">
            awork
          </span>{" "}
          were auto-filled from the awork sync; typing a value overrides
          it.
        </p>
      </CardHeader>
      <CardContent>
        {hoursQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-xs">
              <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">
                    Freelancer
                  </th>
                  {months.map((m) => (
                    <th
                      key={m}
                      className="px-2 py-2 text-right font-medium tabular-nums"
                    >
                      {m}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {freelancers.map((a) => {
                  const rowTotal = months.reduce((sum, m) => {
                    const v = byKey.get(`${a.assignment_id}|${m}`);
                    return sum + (v ? Number(v.hours) : 0);
                  }, 0);
                  return (
                    <tr key={a.assignment_id} className="hover:bg-muted/20">
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium">
                        {a.who_name ?? `assignment ${a.assignment_id}`}
                        <div className="text-[10px] text-muted-foreground">
                          {a.start_date ?? "—"} → {a.end_date ?? "open"}
                        </div>
                      </td>
                      {months.map((m) => {
                        const key = `${a.assignment_id}|${m}`;
                        const cell = byKey.get(key);
                        const inRange = monthInRange(
                          m,
                          a.start_date ?? null,
                          a.end_date ?? null,
                        );
                        if (editing === key) {
                          return (
                            <td key={m} className="px-1 py-1">
                              <input
                                autoFocus
                                type="number"
                                min={0}
                                step={0.25}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => commit(a.assignment_id, m)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    commit(a.assignment_id, m);
                                  if (e.key === "Escape") setEditing(null);
                                }}
                                className="w-16 rounded border bg-background px-1 py-0.5 text-right tabular-nums"
                              />
                            </td>
                          );
                        }
                        return (
                          <td
                            key={m}
                            className={cn(
                              "cursor-pointer px-2 py-2 text-right tabular-nums hover:bg-muted/40",
                              !inRange && "opacity-40",
                            )}
                            onClick={() => startEdit(key, cell?.hours)}
                          >
                            {cell ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="font-medium">
                                  {formatHours(cell.hours)}
                                </span>
                                {cell.source === "awork" && (
                                  <span className="rounded bg-muted px-1 text-[8px] uppercase tracking-wider text-muted-foreground">
                                    awork
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {rowTotal > 0 ? formatHours(String(rowTotal)) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function buildMonthRange(assignments: ProjectAssignment[]): string[] {
  const now = new Date();
  const horizonEnd = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  for (const a of assignments) {
    if (a.start_date) {
      const d = new Date(`${a.start_date.slice(0, 7)}-01T00:00:00Z`);
      if (!minStart || d < minStart) minStart = d;
    }
    if (a.end_date) {
      const d = new Date(`${a.end_date.slice(0, 7)}-01T00:00:00Z`);
      if (!maxEnd || d > maxEnd) maxEnd = d;
    }
  }
  if (!minStart) {
    minStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  }
  const end = maxEnd && maxEnd > horizonEnd ? maxEnd : horizonEnd;

  const out: string[] = [];
  const cur = new Date(minStart.getFullYear(), minStart.getMonth(), 1);
  // Cap at 18 columns so the grid stays scannable.
  while (cur <= end && out.length < 18) {
    out.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`,
    );
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function monthInRange(
  year_month: string,
  start_date: string | null,
  end_date: string | null,
): boolean {
  const ym = year_month;
  if (start_date && ym < start_date.slice(0, 7)) return false;
  if (end_date && ym > end_date.slice(0, 7)) return false;
  return true;
}

function formatHours(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  // Drop trailing zeros after the decimal for tidy display (40 not 40.00),
  // keep two-place precision when there's a fractional part.
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}
