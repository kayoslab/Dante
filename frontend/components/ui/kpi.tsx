"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type KpiTone = "positive" | "negative" | "amber" | "muted" | null;

const toneClass: Record<NonNullable<KpiTone>, string> = {
  positive: "text-emerald-700",
  negative: "text-red-700",
  amber: "text-amber-700",
  muted: "text-muted-foreground",
};

/** Single labelled metric.
 *
 * - `value` accepts a `ReactNode` so callers can pass already-formatted
 *   strings (from `formatEUR`, `formatPercent`) or richer children
 *   (icons, badges).
 * - `emphasize` bumps the value font-size + weight. Useful as the
 *   "headline" KPI of a grid.
 * - `tone` colors the value text (semantic, not the label).
 * - `hint` surfaces a native `title` tooltip on hover — fine for short
 *   explanatory text, no Radix Tooltip overhead.
 * - `sub` adds a small dim line beneath the value (used by the time-tracking
 *   page to show e.g. "of N total"); omit for the common case.
 */
export function Kpi({
  label,
  value,
  emphasize,
  tone,
  hint,
  sub,
}: {
  label: string;
  value: ReactNode;
  emphasize?: boolean;
  tone?: KpiTone;
  hint?: string;
  sub?: ReactNode;
}) {
  return (
    <div title={hint}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 tabular-nums",
          emphasize
            ? "text-lg font-semibold"
            : "text-base font-semibold",
          tone && toneClass[tone],
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

/** Standard 2-up-to-4-column responsive grid used for KPI rows.
 *
 * `cols` lets callers narrow to 2/3 columns when a section only has that
 * many KPIs. The default `4` matches the most common case.
 */
export function KpiGrid({
  children,
  cols = 4,
  className,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4;
  className?: string;
}) {
  const colsClass =
    cols === 2
      ? "sm:grid-cols-2"
      : cols === 3
        ? "sm:grid-cols-3"
        : "sm:grid-cols-4";
  return (
    <div className={cn("grid grid-cols-2 gap-4", colsClass, className)}>
      {children}
    </div>
  );
}
