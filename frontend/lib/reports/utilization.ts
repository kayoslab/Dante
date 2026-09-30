/** Utilization report builders — shared by the `/api/reports/utilization/*`
 * routes and the server-side prefetch in `app/reports/utilization/page.tsx`.
 *
 * Both callers must produce byte-identical JSON for the same arguments:
 * the page seeds React Query's cache with the builder's output under the
 * same key the client hook uses, so any divergence would show up as a
 * hydration-time refetch. Auth / rate-limit / param validation / audit
 * stay in the route; the page does its own `requireSession` + audit.
 */
import "server-only";

import {
  addMonths,
  firstOfMonth,
  mapWithConcurrency,
} from "@/lib/db/_monthly-helpers";
import {
  computeUtilizationForMonth,
  computeUtilizationMonthDetail,
  listForecastDrivers,
} from "@/lib/db/queries/utilization";

/** Utilization series across a month range — trailing actuals + forecast.
 *
 * For each month: every eligible employee gets a single per-month load
 * (prorated loaded cost, weighted allocation, unallocated cost),
 * grouped twice — once by team and once by role tier. Drives the
 * trend chart, the KPI tiles, and the per-row sparklines.
 *
 * Forecast drivers (projects ending + hires starting) are bundled with
 * the same window so the chart's forecast tail has explanatory context
 * without a second round-trip.
 *
 * `from_month` / `to_month` are `YYYY-MM`; the window is capped at 24
 * months. */
export async function buildUtilizationSeries(
  from_month_ym: string,
  to_month_ym: string,
) {
  const from_month = firstOfMonth(`${from_month_ym}-01`);
  const to_month = firstOfMonth(`${to_month_ym}-01`);
  const months: string[] = [];
  let cur = from_month;
  while (cur <= to_month && months.length < 24) {
    months.push(cur.slice(0, 7));
    cur = addMonths(cur, 1);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Forecast-drivers window — the months whose start is strictly in
  // the future. If none (caller didn't request any forecast months),
  // the window collapses to empty and the lists come back empty.
  const future_months = months.filter((m) => `${m}-01` > today);
  let from_drv = today;
  let to_drv = today;
  if (future_months.length > 0) {
    from_drv = `${future_months[0]}-01`;
    // Last day of the last forecast month
    const last = future_months[future_months.length - 1];
    to_drv = firstOfMonth(`${last}-01`);
    to_drv = addMonths(to_drv, 1);
    // addMonths returns first of next month; subtract one day for "last day"
    const d = new Date(`${to_drv}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    to_drv = d.toISOString().slice(0, 10);
  }

  const [points, forecast_drivers] = await Promise.all([
    // Bounded month fan-out: each month is internally parallel already;
    // running all 16 at once would just flood the pg pool queue.
    mapWithConcurrency(months, 2, (monthYm) =>
      computeUtilizationForMonth(monthYm, today),
    ),
    future_months.length > 0
      ? listForecastDrivers(from_drv, to_drv)
      : Promise.resolve({
          from_date: from_drv,
          to_date: to_drv,
          projects_ending: [],
          hires_starting: [],
        }),
  ]);

  return { points, forecast_drivers };
}

/** Selected-month consultant lists: benched (util < 1, with "since N
 * days" duration) and overbooked (util > 1), plus the realized
 * billable-util aggregates (null for fully-future months). */
export async function buildUtilizationMonth(month: string) {
  const today = new Date().toISOString().slice(0, 10);
  // One pass: consultant lists + realized billable-util aggregates
  // (billable_util is null for fully-future months).
  const detail = await computeUtilizationMonthDetail(month, today);
  return { month, ...detail };
}
