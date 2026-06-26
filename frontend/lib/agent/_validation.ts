/** Shared validation helpers for the agent write surface.
 *
 * Centralized so every write route uses the SAME rules — Zod regex
 * alone accepts shapes like `2025-13-40` that aren't real calendar
 * dates, and ILIKE patterns need wildcard escaping so a caller can't
 * turn a fuzzy match into a full-table scan with `q="%"`. */
import { z } from "zod";

/** ISO 8601 calendar-day string (`YYYY-MM-DD`) that PARSES to a real
 * date. The regex alone accepts `2025-13-40`; this refinement rejects
 * months > 12, days outside the month's actual length (incl. leap
 * years), and any other inputs Date can't make sense of. */
export const IsoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine(isRealCalendarDate, "not a real calendar date");

/** Year-month bucket (`YYYY-MM`) constrained to a real calendar month. */
export const IsoYearMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "expected YYYY-MM")
  .refine((s) => {
    const m = Number(s.slice(5, 7));
    return m >= 1 && m <= 12;
  }, "not a real calendar month");

function isRealCalendarDate(s: string): boolean {
  // Parse as UTC to avoid surprises from local-timezone DST gaps —
  // we only care that the (year, month, day) triple is a valid
  // calendar date, not what wall-clock time it represents.
  const [yStr, mStr, dStr] = s.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = Date.UTC(y, m - 1, d);
  if (Number.isNaN(t)) return false;
  const dt = new Date(t);
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Escape `%`, `_`, and `\` so a caller-supplied `q` becomes a LITERAL
 * substring in an `ILIKE '%' || q || '%'` pattern.
 *
 * Without this, `q="%"` matches every row in the table (effectively a
 * filter bypass for the limited search surface) and `q="_"` matches
 * every single-character name. Drizzle bind-parameterizes the value
 * so SQL injection isn't possible, but Postgres still interprets the
 * pattern metacharacters inside the bound string. */
export function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
