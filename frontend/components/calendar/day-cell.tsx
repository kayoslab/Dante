"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CalendarCell, CalendarDay } from "@/lib/api/calendar";
import { cn } from "@/lib/utils";
import { formatRate } from "@/lib/format";

// Cell precedence (top → bottom, first match wins):
//   1. vacation         — amber, intentional time off
//   2. public holiday   — amber tint, no work expected
//   3. weekend          — muted gray, no work expected
//   4. allocation       — blue scale by load, red on overbook
//   5. empty            — nothing
// Weekend / holiday override allocation: people aren't expected to work, so
// surfacing "Friday at 100% but it's Karfreitag" matters more than the load.
function colorClass(
  allocation: number,
  onVacation: boolean,
  hasHoliday: boolean,
  isWeekend: boolean,
): string {
  if (onVacation) return "bg-amber-200/80";
  if (hasHoliday) return "bg-amber-100/60";
  if (isWeekend) return "bg-muted/30";
  if (allocation > 1.0) return "bg-red-300";
  if (allocation >= 1.0) return "bg-blue-400";
  if (allocation >= 0.75) return "bg-blue-300";
  if (allocation >= 0.5) return "bg-blue-200";
  if (allocation > 0) return "bg-blue-100";
  return "";
}

type Props = {
  day: CalendarDay;
  cell: CalendarCell | undefined;
  employeeName: string;
  onClick?: () => void;
  // True for days outside the employee's contract window — rendered as a
  // diagonal-striped muted box, no tooltip and no click target since you
  // can't allocate someone before their hire date or after their last day.
  offContract?: boolean;
};

// Diagonal stripe pattern for "off-contract" cells. Inline because Tailwind
// 4's arbitrary backgrounds are awkward to compose with weekend muting.
const OFF_CONTRACT_BG: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgba(0,0,0,0.06) 0 2px, transparent 2px 6px)",
  backgroundColor: "rgb(244 244 245)", // ~ zinc-100
};


export function DayCell({
  day,
  cell,
  employeeName,
  onClick,
  offContract = false,
}: Props) {
  if (offContract) {
    return (
      <div
        className="h-9 border-r border-b"
        style={OFF_CONTRACT_BG}
        aria-label={`${employeeName} not under contract on ${day.date}`}
      />
    );
  }

  const allocation = cell ? Number(cell.allocation_pct) : 0;
  const onVacation = cell?.on_vacation ?? false;
  const holiday = day.public_holiday;
  const trackedHours = cell?.tracked_hours ?? 0;

  // Tooltip when there's data: allocation, vacation, holiday, or tracked hours.
  const hasTooltip = !!cell || !!holiday;

  const base = cn(
    "h-9 relative border-r border-b transition outline-none",
    colorClass(allocation, onVacation, !!holiday, day.weekend),
    // Subtle outline on cells with tracked time but no assignment-driven
    // allocation — surfaces "someone worked here despite no plan".
    trackedHours > 0 && allocation === 0 && !onVacation &&
      "bg-emerald-50/60 ring-1 ring-inset ring-emerald-200",
    onClick && "cursor-pointer hover:ring-1 hover:ring-inset hover:ring-blue-500/60",
    onClick && "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500",
    !onClick && hasTooltip && "cursor-help",
  );

  const handleKeyDown = onClick
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }
    : undefined;

  const trigger = (
    <div
      className={base}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={onClick ? 0 : -1}
      role={onClick ? "button" : undefined}
      aria-label={onClick ? `Allocate ${employeeName} on ${day.date}` : undefined}
    >
      {trackedHours > 0 && (
        <span
          className={cn(
            "pointer-events-none absolute bottom-0 right-0 px-0.5 text-[9px] leading-none tabular-nums",
            // Higher-contrast color depending on cell background tone.
            allocation > 0 || onVacation
              ? "text-foreground/80"
              : "text-emerald-800",
          )}
        >
          {trackedHours}h
        </span>
      )}
    </div>
  );

  if (!hasTooltip) {
    // No data but possibly clickable.
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent className="max-w-xs">
        <div className="space-y-1.5">
          <div className="text-sm font-medium">{employeeName}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {day.date}
          </div>
          {holiday && (
            <div className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
              Feiertag: {holiday}
            </div>
          )}
          {onVacation && cell?.vacation_type && (
            <div className="rounded bg-amber-200 px-2 py-1 text-xs text-amber-900">
              {cell.vacation_type}
            </div>
          )}
          {cell && cell.assignments.length > 0 && (
            <ul className="space-y-1.5 pt-1">
              {cell.assignments.map((a) => (
                <li key={a.assignment_id} className="text-xs">
                  <div className="font-medium">
                    {a.customer_name} / {a.project_name}
                  </div>
                  <div className="text-muted-foreground tabular-nums">
                    {a.profile ?? "—"} · {Number(a.allocation_pct).toFixed(2)}
                    {a.daily_rate_eur && (
                      <>
                        {" · "}
                        <span className="whitespace-nowrap">
                          {formatRate(a.daily_rate_eur)}/d
                        </span>
                      </>
                    )}
                  </div>
                </li>
              ))}
              {allocation > 0 && cell && cell.assignments.length > 1 && (
                <li className="border-t pt-1 text-xs font-medium tabular-nums">
                  total: {allocation.toFixed(2)}
                </li>
              )}
            </ul>
          )}
          {allocation > 1.0 && (
            <div className="rounded bg-red-100 px-2 py-1 text-xs text-red-800">
              ⚠ Overbooked ({allocation.toFixed(2)} of 1.00)
            </div>
          )}
          {cell && cell.tracked_entries.length > 0 && (
            <div className="border-t pt-1">
              <div className="text-xs font-medium">
                Tracked: {cell.tracked_hours}h
              </div>
              <ul className="mt-1 space-y-0.5">
                {cell.tracked_entries.map((e, i) => (
                  <li
                    key={`${e.source}-${e.project_name}-${i}`}
                    className="text-xs"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {e.hours}h
                    </span>{" "}
                    <span className="text-muted-foreground">
                      [{e.source}]
                    </span>{" "}
                    {e.project_name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
