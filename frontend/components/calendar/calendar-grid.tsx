"use client";

import { Fragment, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CalendarEmployee,
  CalendarPayload,
} from "@/lib/api/calendar";
import { cn } from "@/lib/utils";
import { DayCell } from "./day-cell";

const NAME_COL_PX = 200;
const WEEKDAY_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

type TeamGroup = {
  team: string | null | undefined;
  employees: CalendarEmployee[];
};

type Props = {
  data: CalendarPayload | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onCellClick?: (employee: CalendarEmployee, date: string) => void;
};

export function CalendarGrid({
  data,
  isLoading,
  isError,
  error,
  onCellClick,
}: Props) {
  // Build a fast lookup: "employee_id|date" → cell.
  const cellsByKey = useMemo(() => {
    const m = new Map<string, NonNullable<typeof data>["cells"][number]>();
    if (data) for (const c of data.cells) m.set(`${c.employee_id}|${c.date}`, c);
    return m;
  }, [data]);

  // Group employees by team, preserving the backend's (team, last_name) order.
  const teamGroups: TeamGroup[] = useMemo(() => {
    if (!data) return [];
    const groups: TeamGroup[] = [];
    for (const emp of data.employees) {
      const last = groups[groups.length - 1];
      if (last && last.team === emp.team) {
        last.employees.push(emp);
      } else {
        groups.push({ team: emp.team, employees: [emp] });
      }
    }
    return groups;
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load calendar:{" "}
        {error instanceof Error ? error.message : "unknown"}
      </div>
    );
  }

  if (data.employees.length === 0) {
    return (
      <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
        No employees match the current filters.
      </div>
    );
  }

  // Single-month view: day columns share the available width equally, so the
  // grid always fits the viewport without horizontal scrolling.
  // `minmax(0, 1fr)` lets columns shrink below their intrinsic content width
  // — without minmax, the day-number text would force a min width and the
  // grid could overflow.
  const gridStyle = {
    gridTemplateColumns: `${NAME_COL_PX}px repeat(${data.days.length}, minmax(0, 1fr))`,
  } as const;

  const todayIndex = data.days.findIndex((d) => d.today);

  return (
    <div>
      <div className="relative">
      <div className="grid overflow-hidden rounded-md border bg-background" style={gridStyle}>
        {/* corner cell */}
        <div className="sticky top-0 z-30 border-b border-r bg-background px-3 py-2 text-xs font-medium text-muted-foreground">
          Employee
        </div>

        {/* day headers */}
        {data.days.map((d) => {
          const dt = new Date(d.date);
          return (
            <div
              key={d.date}
              title={d.public_holiday ?? undefined}
              className={cn(
                "sticky top-0 z-20 border-b border-r text-center text-xs",
                d.weekend
                  ? "bg-muted/50"
                  : d.public_holiday
                    ? "bg-amber-100/80"
                    : "bg-background",
                d.today && "ring-1 ring-inset ring-blue-500",
              )}
            >
              <div className="tabular-nums">{dt.getDate()}</div>
              <div className="text-muted-foreground">{WEEKDAY_DE[dt.getDay()]}</div>
            </div>
          );
        })}

        {/* team-grouped employee rows */}
        {teamGroups.map((group) => (
          <Fragment key={group.team ?? "_no_team"}>
            {/* Team header row — single grid cell spanning all columns. */}
            <div
              style={{ gridColumn: "1 / -1" }}
              className="border-b border-t bg-muted/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {group.team ?? "Other"}
              <span className="ml-2 text-muted-foreground/70 normal-case font-normal tracking-normal">
                · {group.employees.length}
              </span>
            </div>
            {group.employees.map((emp) => (
              <Fragment key={emp.employee_id}>
                <div className="flex flex-col justify-center border-b border-r bg-background px-3 py-1">
                  <div className="truncate text-sm font-medium leading-tight">
                    {emp.first_name} {emp.last_name}
                  </div>
                  <div className="flex gap-2 truncate text-xs text-muted-foreground">
                    {emp.role_tier ?? "—"}
                    {emp.fte && emp.fte < 1 && (
                      <span className="rounded bg-muted px-1.5 tabular-nums">
                        {Math.round(emp.fte * 100)}%
                      </span>
                    )}
                  </div>
                </div>
                {data.days.map((d) => {
                  const cell = cellsByKey.get(`${emp.employee_id}|${d.date}`);
                  const employeeName = `${emp.first_name} ${emp.last_name}`;
                  // ISO YYYY-MM-DD string comparison is lexically correct.
                  const offContract =
                    (!!emp.hire_date && d.date < emp.hire_date) ||
                    (!!emp.contract_end_date && d.date > emp.contract_end_date);
                  return (
                    <DayCell
                      key={`${emp.employee_id}|${d.date}`}
                      day={d}
                      cell={cell}
                      employeeName={employeeName}
                      offContract={offContract}
                      onClick={
                        onCellClick && !offContract
                          ? () => onCellClick(emp, d.date)
                          : undefined
                      }
                    />
                  );
                })}
              </Fragment>
            ))}
          </Fragment>
        ))}

      </div>

      {/* Today vertical marker. Absolute overlay rather than a grid item so
          we don't disrupt CSS-grid auto-flow (definite-position items steal
          cells from auto-placed ones). `left` is computed from the column
          ratio so it stays aligned as 1fr columns resize with the viewport. */}
      {todayIndex >= 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 z-[5] w-0.5 bg-blue-500"
          style={{
            left: `calc(${NAME_COL_PX}px + (100% - ${NAME_COL_PX}px) * ${todayIndex} / ${data.days.length})`,
          }}
        />
      )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <Legend swatch="bg-blue-100" label="< 50% load" />
        <Legend swatch="bg-blue-200" label="50–74% load" />
        <Legend swatch="bg-blue-300" label="75–99% load" />
        <Legend swatch="bg-blue-400" label="100% load" />
        <Legend swatch="bg-red-300" label=">100% load (overbook, assignment-only)" />
        <Legend swatch="bg-amber-200/80" label="Vacation/absence" />
        <Legend swatch="bg-amber-100/80" label="Public holiday (federal or local state)" />
        <Legend swatch="bg-muted/50" label="Weekend" />
        <Legend
          swatch=""
          swatchStyle={{
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(0,0,0,0.06) 0 2px, transparent 2px 6px)",
            backgroundColor: "rgb(244 244 245)",
          }}
          label="Outside contract"
        />
      </div>
    </div>
  );
}

function Legend({
  swatch,
  swatchStyle,
  label,
}: {
  swatch: string;
  swatchStyle?: React.CSSProperties;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("inline-block h-3 w-4 rounded border", swatch)}
        style={swatchStyle}
      />
      {label}
    </span>
  );
}
