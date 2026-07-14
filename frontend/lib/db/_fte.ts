import Decimal from "decimal.js";

/** FTE from `weekly_working_hours`: 40h/week = 1.0; null / 0 → 1.0 (treat
 * unknown as full-time). Pure (no DB) so the utilization / bench math that
 * relies on it stays unit-testable.
 *
 * Why it matters: `assignment.allocation_pct` is a fraction of full-time
 * (the awork planner sync divides planned hours by an 8h day), so a
 * fully-booked part-timer's weighted allocation equals their FTE. Anything
 * that treats "fully utilized" as a hardcoded 1.0 shows part-timers as
 * spuriously benched — measure against this FTE instead. */
export function fteFromWeeklyHours(
  weekly_working_hours: number | null | undefined,
): Decimal {
  if (!weekly_working_hours || weekly_working_hours <= 0) return new Decimal(1);
  return new Decimal(weekly_working_hours).div(40);
}
