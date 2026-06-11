/** Per-freelancer, per-month profitability breakdown.
 *
 * Source of truth for `/api/freelancers/[id]/monthly` and the series
 * route. Pure data — no auth.
 *
 * Cost rule for freelancers:
 *   - If a `freelancer_time_entry` row exists for (assignment, month),
 *     use `entered_hours × (daily_cost / 8)` — those are actual tracked
 *     hours and represent the real freelancer cost.
 *   - Otherwise fall back to allocation-based planning estimate:
 *     `daily_cost × 20 × allocation × active_days / n_wd`.
 *
 * Both manual and awork-sourced entries count as "actuals" — the action
 * layer guarantees one row per cell, and manual writes always win over
 * awork on conflict. This matches the override in `cumulativeProjectCost`
 * so per-freelancer and per-project views stay in sync. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  burdenFactor,
  entityMonthlyCost,
  fmt,
  fpRecognizedRevenueForMonth,
  holidaysForYearOf,
  lastOfMonth,
  projectTotalWeightedAllocInMonth,
  resolveRateForDay,
  workingDaysInRange,
} from "../_monthly-helpers";

export type FreelancerMonthlyBreakdown = Record<string, unknown> & {
  entity_kind: "freelancer";
  entity_id: number;
  month: string;
  assignments: Array<Record<string, unknown>>;
};

/** Returns null when the freelancer row doesn't exist; route maps to 404. */
export async function computeFreelancerMonthly(
  freelancer_id: number,
  monthYm: string,
): Promise<FreelancerMonthlyBreakdown | null> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);

  const r = await db.execute(sql`
    SELECT name FROM freelancer WHERE freelancer_id = ${freelancer_id}
  `);
  const flRow = (r.rows as Array<{ name: string }>)[0];
  if (!flRow) return null;
  const who_name = flRow.name;

  const holidays = holidaysForYearOf(month_start);
  const working_days = workingDaysInRange(month_start, month_end, holidays);
  const n_wd = working_days.length;
  const burden = await burdenFactor();

  const asnRes = await db.execute(sql`
    SELECT a.assignment_id, a.project_id, p.name AS project_name, c.name AS customer_name,
           p.billing_model, p.framework_id, a.profile,
           a.allocation_pct, a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE a.freelancer_id = ${freelancer_id}
      AND a.start_date <= ${month_end}::date
      AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
    ORDER BY a.assignment_id
  `);

  // Entered hours for this freelancer's assignments in the target month.
  // Keyed by assignment_id since the query is already filtered to monthYm.
  // Empty map → no rows; the per-assignment branch falls back to allocation.
  const enteredHoursRes = await db.execute(sql`
    SELECT fte.assignment_id, fte.hours_decimal
    FROM freelancer_time_entry fte
    JOIN assignment a ON a.assignment_id = fte.assignment_id
    WHERE a.freelancer_id = ${freelancer_id}
      AND fte.year_month = ${monthYm}
  `);
  const enteredHours = new Map<number, Decimal>();
  for (const r of enteredHoursRes.rows as Array<Record<string, unknown>>) {
    enteredHours.set(
      r.assignment_id as number,
      new Decimal(r.hours_decimal as string),
    );
  }

  const assignment_rows: Array<Record<string, unknown>> = [];
  let total_revenue = new Decimal(0);
  let total_cost = new Decimal(0);
  const project_weighted_cache = new Map<number, Decimal>();

  for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
    const asn_id = raw.assignment_id as number;
    const project_id = raw.project_id as number;
    const project_name = raw.project_name as string;
    const customer_name = raw.customer_name as string;
    const billing = raw.billing_model as string;
    const framework_id = raw.framework_id as number | null;
    const profile = raw.profile as string | null;
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end = raw.end_date as string | null;
    const rate_ov =
      raw.daily_rate_override_eur === null ||
      raw.daily_rate_override_eur === undefined
        ? null
        : new Decimal(raw.daily_rate_override_eur as string);
    const cost_ov =
      raw.daily_cost_override_eur === null ||
      raw.daily_cost_override_eur === undefined
        ? null
        : new Decimal(raw.daily_cost_override_eur as string);

    const a_window_start = a_start > month_start ? a_start : month_start;
    const a_window_end =
      a_end === null ? month_end : a_end < month_end ? a_end : month_end;
    const active_days = working_days.filter(
      (d) => d >= a_window_start && d <= a_window_end,
    );

    const { monthly_cost: monthly_cost_full, standard_daily_hours } =
      await entityMonthlyCost(null, freelancer_id, cost_ov, burden);
    let cost_share = new Decimal(0);
    const entered = enteredHours.get(asn_id);
    if (entered !== undefined && monthly_cost_full !== null) {
      // Actual hours win — entered tracked hours × hourly cost. Matches
      // the freelancer branch of cumulativeProjectCost so the per-freelancer
      // and per-project numbers agree to the cent.
      const cost_per_hour = monthly_cost_full
        .div(20)
        .div(standard_daily_hours);
      cost_share = cost_per_hour.mul(entered);
    } else if (monthly_cost_full !== null && n_wd > 0 && active_days.length > 0) {
      cost_share = monthly_cost_full
        .mul(alloc)
        .mul(active_days.length)
        .div(n_wd);
    }
    total_cost = total_cost.add(cost_share);

    let revenue = new Decimal(0);
    let rate_unresolved_days = 0;
    if (billing === "time_and_material") {
      for (const day of active_days) {
        const r2 = await resolveRateForDay(
          project_id,
          framework_id,
          profile,
          day,
          rate_ov,
        );
        if (r2 !== null) {
          revenue = revenue.add(r2.mul(alloc));
        } else {
          rate_unresolved_days++;
        }
      }
    } else {
      const weighted_alloc_i =
        n_wd > 0 ? alloc.mul(active_days.length).div(n_wd) : new Decimal(0);
      if (!project_weighted_cache.has(project_id)) {
        project_weighted_cache.set(
          project_id,
          await projectTotalWeightedAllocInMonth(
            project_id,
            month_start,
            month_end,
            working_days,
          ),
        );
      }
      const proj_total = project_weighted_cache.get(project_id)!;
      const fp_rec = await fpRecognizedRevenueForMonth(
        project_id,
        month_start,
        month_end,
      );
      if (fp_rec !== null && proj_total.gt(0) && weighted_alloc_i.gt(0)) {
        revenue = fp_rec.mul(weighted_alloc_i).div(proj_total);
      }
    }
    total_revenue = total_revenue.add(revenue);

    assignment_rows.push({
      assignment_id: asn_id,
      profile,
      allocation_pct: alloc.toFixed(4),
      active_working_days: active_days.length,
      absence_days: 0,
      billable_days: active_days.length,
      rate_unresolved_days,
      project_id,
      project_name,
      customer_name,
      billing_model: billing,
      revenue: fmt(revenue, 2),
      cost: fmt(cost_share, 2),
    });
  }

  const margin = total_revenue.sub(total_cost);
  const margin_pct = total_cost.gt(0)
    ? margin.div(total_cost).mul(100)
    : null;
  const rate_unresolved_total = assignment_rows.reduce(
    (a, r) => a + (r.rate_unresolved_days as number),
    0,
  );

  return {
    entity_kind: "freelancer",
    entity_id: freelancer_id,
    who_name,
    month: monthYm,
    month_start,
    month_end,
    working_days_in_month: n_wd,
    cost: fmt(total_cost, 2),
    revenue: fmt(total_revenue, 2),
    margin: fmt(margin, 2),
    margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
    rate_unresolved_days: rate_unresolved_total,
    assignments: assignment_rows,
  };
}
