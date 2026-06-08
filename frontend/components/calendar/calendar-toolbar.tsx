"use client";

import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function labelFor(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth()
  ) {
    return `${MONTHS_DE[s.getMonth()]} ${s.getFullYear()}`;
  }
  const sM = MONTHS_DE[s.getMonth()];
  const eM = MONTHS_DE[e.getMonth()];
  const sY = s.getFullYear();
  const eY = e.getFullYear();
  return sY === eY ? `${sM} – ${eM} ${eY}` : `${sM} ${sY} – ${eM} ${eY}`;
}

type Props = {
  start: string;
  end: string;
  onPrevious: () => void;
  onToday: () => void;
  onNext: () => void;
  includeNonContributing: boolean;
  onToggleNonContributing: (value: boolean) => void;
};

export function CalendarToolbar({
  start,
  end,
  onPrevious,
  onToday,
  onNext,
  includeNonContributing,
  onToggleNonContributing,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onToday}>
          <CalendarIcon className="mr-2 h-4 w-4" />
          Today
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="ml-2 text-sm font-medium tabular-nums">
          {labelFor(start, end)}
        </span>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeNonContributing}
          onChange={(e) => onToggleNonContributing(e.target.checked)}
        />
        Show non-contributing employees
      </label>
    </div>
  );
}
