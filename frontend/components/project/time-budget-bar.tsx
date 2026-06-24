"use client";

import { cn } from "@/lib/utils";

/** Shared two-segment burn-down bar — solid for hours tracked so far,
 * lighter for hours committed to future assignments, gap to the right
 * edge for unplanned remaining budget. Used by the FP burn-down report
 * row and the project detail page's time-budget block.
 *
 * Tone is driven by the *projected* position (tracked + planned), not
 * just tracked-so-far: amber > 110% projected, red ≥ 100% tracked
 * (already exhausted), emerald otherwise. */
export function TimeBudgetBar({
  trackedHours,
  budgetHours,
  futurePlannedHours,
}: {
  trackedHours: number;
  budgetHours: number;
  futurePlannedHours: number;
}) {
  const tracked = Math.max(trackedHours, 0);
  const planned = Math.max(futurePlannedHours, 0);
  const trackedRaw = budgetHours > 0 ? tracked / budgetHours : 0;
  const projectedRaw = budgetHours > 0 ? (tracked + planned) / budgetHours : 0;
  const trackedClamped = Math.min(trackedRaw, 1);
  const plannedClamped = Math.min(
    Math.max(projectedRaw - trackedRaw, 0),
    1 - trackedClamped,
  );
  const tone =
    trackedRaw >= 1
      ? "bg-red-500/70"
      : projectedRaw > 1.1
        ? "bg-amber-500/70"
        : "bg-emerald-500/70";
  const plannedTone =
    projectedRaw > 1
      ? "bg-red-300/60"
      : projectedRaw > 1.1
        ? "bg-amber-300/60"
        : "bg-emerald-300/60";
  return (
    <div className="relative flex h-3 overflow-hidden rounded bg-muted">
      <div
        className={cn("h-full", tone)}
        style={{ width: `${trackedClamped * 100}%` }}
        title={`Tracked ${tracked.toFixed(0)}h`}
      />
      {plannedClamped > 0 && (
        <div
          className={cn("h-full", plannedTone)}
          style={{ width: `${plannedClamped * 100}%` }}
          title={`Planned future ${planned.toFixed(0)}h`}
        />
      )}
    </div>
  );
}
