/** Tracked-hours month report builder.
 *
 * Shared by `GET /api/tracked-hours` and the server-side prefetch in
 * `app/reports/time/page.tsx`, so both produce the exact same wire
 * object (`TrackedHoursMonth`). Route-level concerns — auth, rate limit,
 * param validation — stay in the route; this module only shapes data.
 */
import "server-only";

import { germanFederalHolidays } from "@/lib/db/_de-holidays";
import {
  getAvailableHoursForEmployees,
  getTrackedHoursForMonth,
} from "@/lib/db/queries/tracked-hours";

function lastOfMonth(monthStart: string): string {
  // monthStart is YYYY-MM-01. Last day = next month - 1 day.
  const d = new Date(monthStart);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export async function buildTrackedHoursMonth({
  month,
  team,
}: {
  month: string;
  team: string | null;
}) {
  const monthParam = month;
  const month_start = `${monthParam}-01`;
  const month_end = lastOfMonth(month_start);

  // Working days in the month, excluding weekends and DE federal holidays.
  const year = Number(monthParam.slice(0, 4));
  const holidays = germanFederalHolidays(year, year);
  let n_working = 0;
  const cur = new Date(month_start);
  const last = new Date(month_end);
  while (cur <= last) {
    const wd = cur.getUTCDay();
    const iso = cur.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !holidays.has(iso)) n_working++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const rows = await getTrackedHoursForMonth({
    month_start,
    month_end,
    team,
  });
  // Available hours per consultant (contract + office-state holidays −
  // absences) — the "how much could they have worked" reference.
  const available = await getAvailableHoursForEmployees(
    rows.map((r) => r.employee_id),
    month_start,
    month_end,
  );

  let total_b = 0;
  let total_nb = 0;
  let total_n = 0;
  const consultants = rows.map((r) => {
    const b_h = Math.round(r.b_min / 60);
    const nb_h = Math.round(r.nb_min / 60);
    const n_h = Math.round(r.n_min / 60);
    total_b += b_h;
    total_nb += nb_h;
    total_n += n_h;
    return {
      employee_id: r.employee_id,
      first_name: r.first_name,
      last_name: r.last_name,
      team: r.team,
      available_hours: available.get(r.employee_id) ?? 0,
      billable_hours: b_h,
      // Non-billable (internal projects) + untagged = internal time.
      non_billable_hours: nb_h,
      untagged_hours: n_h,
      total_hours: b_h + nb_h + n_h,
    };
  });

  let total_available = 0;
  for (const r of rows) total_available += available.get(r.employee_id) ?? 0;
  // Billable utilization from UNROUNDED minutes — the per-consultant hour
  // figures above are display-rounded, and summing those drifts the KPI by
  // a few tenths of a percent vs. the utilization report's exact math.
  const exact_billable_h =
    rows.reduce((acc, r) => acc + r.b_min, 0) / 60;
  const billable_util_pct =
    total_available > 0
      ? Number(((exact_billable_h / total_available) * 100).toFixed(1))
      : null;

  return {
    month: monthParam,
    month_start,
    month_end,
    working_days_in_month: n_working,
    n_consultants: consultants.length,
    total_available_hours: Number(total_available.toFixed(0)),
    billable_util_pct,
    total_billable_hours: total_b,
    total_non_billable_hours: total_nb,
    total_untagged_hours: total_n,
    total_hours: total_b + total_nb + total_n,
    consultants,
  };
}
