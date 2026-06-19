"use client";

import { useCallback, useState } from "react";

import { CalendarGrid } from "@/components/calendar/calendar-grid";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { AllocateFromCellDialog } from "@/components/calendar/allocate-from-cell-dialog";
import { useCalendar, type CalendarEmployee } from "@/lib/api/calendar";

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonthOffset(d: Date, monthsForward: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + monthsForward + 1, 0);
}
function shiftMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1);
}

// Single-month view: prev/today/next on the toolbar pages by one month.
// One month keeps the grid narrow enough to fit any viewport without
// horizontal scrolling, and makes the "active during this window" employee
// filter exact — someone whose contract ends mid-month stays visible (with
// post-end days rendered as off-contract), and someone who left earlier
// doesn't appear at all.
const MONTHS_VISIBLE = 1;

type Selection = {
  employeeId: number;
  employeeName: string;
  date: string;
};

export function CalendarClient({ canAllocate }: { canAllocate: boolean }) {
  const [anchor, setAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [includeNonContrib, setIncludeNonContrib] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  const start = isoOf(anchor);
  const end = isoOf(endOfMonthOffset(anchor, MONTHS_VISIBLE - 1));
  const query = useCalendar(start, end, includeNonContrib);

  const onCellClick = useCallback((emp: CalendarEmployee, date: string) => {
    setSelection({
      employeeId: emp.employee_id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      date,
    });
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        <div className="text-sm text-muted-foreground">
          {query.data?.employees.length ?? 0} employees ·{" "}
          {query.data?.days.length ?? 0} days
        </div>
      </div>
      <CalendarToolbar
        start={start}
        end={end}
        onPrevious={() => setAnchor(shiftMonths(anchor, -1))}
        onToday={() => setAnchor(startOfMonth(new Date()))}
        onNext={() => setAnchor(shiftMonths(anchor, 1))}
        includeNonContributing={includeNonContrib}
        onToggleNonContributing={setIncludeNonContrib}
      />
      <CalendarGrid
        data={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onCellClick={canAllocate ? onCellClick : undefined}
      />

      {selection && (
        <AllocateFromCellDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelection(null);
          }}
          employeeId={selection.employeeId}
          employeeName={selection.employeeName}
          startDate={selection.date}
        />
      )}
    </div>
  );
}
