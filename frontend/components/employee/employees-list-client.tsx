"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useEmployees,
  useEmployeeTeams,
  type EmployeeListItem,
} from "@/lib/api/employees";
import { cn } from "@/lib/utils";

/** Client half of the employees list page. Owns filter state; the SSR
 * server component (`app/employees/page.tsx`) prefetches the default
 * (status=active, no search, no team) view and hydrates the same query
 * key — so first paint has rows, no loading flash. Filter changes
 * trigger client-side TanStack refetches as normal. */
export function EmployeesListClient({
  canViewDetail = true,
  ownEmployeeId = null,
}: {
  /** Manager+ can click through to any row. Employees can't. */
  canViewDetail?: boolean;
  /** When the signed-in user IS an employee, their own row becomes a link
   * to /profile so they retain a path to their own data. */
  ownEmployeeId?: number | null;
}) {
  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("");
  const [showInactive, setShowInactive] = useState(false);

  const { data: teams = [] } = useEmployeeTeams();
  const { data, isLoading, isError, error } = useEmployees({
    q: q.length >= 2 ? q : undefined,
    team: team || undefined,
    status: showInactive ? undefined : "active",
  });

  const counts = useMemo(() => {
    const all = data?.length ?? 0;
    const flagged = (data ?? []).filter(
      (e) =>
        e.is_real_employee === false ||
        e.is_project_contributing === false ||
        e.is_multi_org === true,
    ).length;
    return { all, flagged };
  }, [data]);

  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-muted-foreground">
            Read-only directory synced from Personio. Edit analytics flags on
            the detail page.
          </p>
        </div>
        <div className="text-sm text-muted-foreground tabular-nums">
          {counts.all} shown
          {counts.flagged > 0 && (
            <span className="ml-2">· {counts.flagged} flagged</span>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <div className="relative flex-1 min-w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search name or email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
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
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={showInactive}
              onCheckedChange={setShowInactive}
            />
            Show inactive
          </label>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {isError && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error instanceof Error ? error.message : "unknown"}
        </div>
      )}
      {data && data.length === 0 && (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No employees match these filters.
        </div>
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Team</th>
                <th className="px-3 py-2 text-left font-medium">Position</th>
                <th className="px-3 py-2 text-left font-medium">Tier</th>
                <th className="px-3 py-2 text-right font-medium">FTE</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((e) => {
                const isOwn =
                  ownEmployeeId !== null && e.employee_id === ownEmployeeId;
                const linkable = canViewDetail || isOwn;
                const href = canViewDetail
                  ? `/employees/${e.employee_id}`
                  : "/profile";
                const name = (
                  <>
                    {e.first_name} {e.last_name}
                  </>
                );
                return (
                  <tr key={e.employee_id} className="hover:bg-muted/20">
                    <td className="px-3 py-2">
                      {linkable ? (
                        <Link
                          href={href}
                          className="font-medium hover:underline"
                        >
                          {name}
                          {isOwn && !canViewDetail && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </Link>
                      ) : (
                        <span className="font-medium">{name}</span>
                      )}
                      {e.contract_end_date && (
                        <div className="text-xs text-amber-700">
                          leaving {e.contract_end_date}
                        </div>
                      )}
                    </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {e.team ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {e.position ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {e.role_tier ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {e.fte ? e.fte.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={e.status === "active" ? "secondary" : "outline"}
                      className={cn(
                        e.status === "inactive" && "text-muted-foreground",
                      )}
                    >
                      {e.status ?? "—"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <FlagChips e={e} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function FlagChips({ e }: { e: EmployeeListItem }) {
  const chips: { label: string; tone: string }[] = [];
  if (e.is_real_employee === false)
    chips.push({ label: "not real", tone: "bg-red-50 text-red-800" });
  if (e.is_project_contributing === false)
    chips.push({ label: "not contributing", tone: "bg-amber-50 text-amber-800" });
  if (e.is_multi_org)
    chips.push({ label: "multi-org", tone: "bg-blue-50 text-blue-800" });
  if (chips.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.label} className={cn("rounded px-1.5 py-0.5", c.tone)}>
          {c.label}
        </span>
      ))}
    </div>
  );
}
