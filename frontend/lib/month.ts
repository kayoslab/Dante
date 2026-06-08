/** Centralized month helpers. The UI passes months around as ISO
 *  `YYYY-MM` strings — these are short, easy to compare, and round-trip
 *  losslessly with the API.
 */

/** `YYYY-MM` for the local date. */
export function isoMonthOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Shift an ISO month by `by` months (can be negative). */
export function shiftMonth(iso: string, by: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return isoMonthOf(d);
}

/** "June 2026" — long label with full month name + year. */
export function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

/** "Jun 26" — short label suitable for chart x-axis ticks. */
export function shortLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}
