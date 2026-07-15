/** Per-project, per-month profitability breakdown.
 *
 * The single source of truth for `/api/projects/[id]/monthly` and
 * everyone who used to fan out to it: portfolio aggregation and the
 * monthly-series route both call this directly instead of going through
 * the HTTP layer. That replaces a per-project internal `fetch` with a
 * plain function call — same DB connection pool, no auth re-entry, no
 * route handler overhead.
 *
 * Returns the same shape the route used to return (so downstream
 * consumers — clients, sibling routes — don't have to change). The
 * `null` return is reserved for "project not found" so the route
 * handler can map it to a 404. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  germanHolidaysForStateCached,
  stateCodeForOffice,
} from "../_de-holidays";
import {
  absencesForEmployee,
  burdenFactor,
  cumulativeProjectBurdenedCost,
  cumulativeProjectCost,
  cumulativeProjectRevenue,
  employeeFte,
  employeeTotalTrackedMinutesInMonth,
  employeeWeightedAllocInMonth,
  entityMonthlyCost,
  fmt,
  fpRecognitionThrough,
  holidaysForYearOf,
  lastOfMonth,
  projectFuturePlannedHours,
  projectHasTimeMapping,
  projectTrackedHoursThrough,
  resolveRateForDay,
  shiftDay,
  trackedMinutesPerEmployeeInMonth,
  unassignedTrackedForProject,
  workingDaysInRange,
} from "../_monthly-helpers";

export type ActiveProjectRow = {
  project_id: number;
  name: string;
  billing_model: string;
  customer_id: number;
  customer_name: string;
};

/** All active projects with their customer name, ordered the way the
 * portfolio page expects (customer asc, project asc). Used by
 * `computeProjectMonthlyRows` to fan out per-project breakdowns. */
export async function listActiveProjectsForPortfolio(): Promise<
  ActiveProjectRow[]
> {
  const r = await db.execute(sql`
    SELECT p.project_id, p.name, p.billing_model,
           c.customer_id, c.name AS customer_name
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.status = 'active'
    ORDER BY c.name, p.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    project_id: row.project_id as number,
    name: row.name as string,
    billing_model: row.billing_model as string,
    customer_id: row.customer_id as number,
    customer_name: row.customer_name as string,
  }));
}

export type UnallocatedPayrollEmployeeRow = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  weekly_working_hours: number | null;
  hire_date: string | null;
  employment_end_date: string | null;
  team: string | null;
  is_real: boolean;
};

/** Active, real, project-contributing employees whose contract overlaps
 * the given month. Drives `computeMonthlyBenchTotals`. */
export async function listUnallocatedPayrollEmployees(
  month_start: string,
  month_end: string,
): Promise<UnallocatedPayrollEmployeeRow[]> {
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.weekly_working_hours,
           ec.hire_date, ec.employment_end_date,
           COALESCE(ann.team_user, ec.department) AS team,
           COALESCE(ann.is_real_employee, TRUE) AS is_real
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      -- Include onboarding (future-start) hires; the hire_date window scopes
      -- them to months they've started (a future hire only appears from their
      -- start month, not the current one).
      AND ec.status IN ('active', 'onboarding')
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${month_end}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${month_start}::date)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    weekly_working_hours:
      row.weekly_working_hours == null ? null : Number(row.weekly_working_hours),
    hire_date: (row.hire_date as string | null) ?? null,
    employment_end_date: (row.employment_end_date as string | null) ?? null,
    team: (row.team as string | null) ?? null,
    is_real: Boolean(row.is_real),
  }));
}

export type ProjectMonthlyBreakdown = Record<string, unknown> & {
  project_id: number;
  project_name: string;
  billing_model: string;
  month: string;
  assignments: Array<Record<string, unknown>>;
  unassigned_tracked: Array<Record<string, unknown>>;
};

/** Compute the full monthly breakdown for a project. Returns null when
 * the project doesn't exist; throws on any other error so the caller
 * sees a 500 (matching the previous route behavior). */
export async function computeProjectMonthly(
  project_id: number,
  monthYm: string,
): Promise<ProjectMonthlyBreakdown | null> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);

  const projRes = await db.execute(sql`
    SELECT name, billing_model, agreed_amount_eur, framework_id,
           planned_start_date, planned_end_date, time_budget_hours
    FROM project WHERE project_id = ${project_id}
  `);
  const projRow = (projRes.rows as Array<Record<string, unknown>>)[0];
  if (!projRow) return null;

  const project_name = projRow.name as string;
  const billing = projRow.billing_model as string;
  const agreed_amount =
    projRow.agreed_amount_eur === null || projRow.agreed_amount_eur === undefined
      ? null
      : new Decimal(projRow.agreed_amount_eur as string);
  const framework_id = (projRow.framework_id as number | null) ?? null;
  const planned_start = (projRow.planned_start_date as string | null) ?? null;
  const planned_end = (projRow.planned_end_date as string | null) ?? null;
  const time_budget_hours =
    projRow.time_budget_hours === null || projRow.time_budget_hours === undefined
      ? null
      : Number(projRow.time_budget_hours);

  const holidays = holidaysForYearOf(month_start);
  const working_days = workingDaysInRange(month_start, month_end, holidays);
  const n_wd = working_days.length;
  const burden = await burdenFactor();

  const today = new Date().toISOString().slice(0, 10);
  const working_days_elapsed = working_days.filter((d) => d <= today).length;
  let month_status: "future" | "in_progress" | "complete";
  if (today < month_start) month_status = "future";
  else if (today >= month_end) month_status = "complete";
  else month_status = "in_progress";
  const elapsed_share =
    month_status === "complete"
      ? new Decimal(1)
      : n_wd === 0
        ? new Decimal(0)
        : new Decimal(working_days_elapsed).div(n_wd);

  const has_time_mapping = await projectHasTimeMapping(project_id);
  const tracked_minutes_per_emp = await trackedMinutesPerEmployeeInMonth(
    project_id,
    month_start,
    month_end,
  );

  const asnRes = await db.execute(sql`
    SELECT a.assignment_id, a.employee_id, a.freelancer_id, a.profile,
           a.allocation_pct, a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur,
           rt.role_tier,
           ec.office AS employee_office
    FROM assignment a
    LEFT JOIN employee_role_tier rt ON rt.employee_id = a.employee_id
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    WHERE a.project_id = ${project_id}
      AND a.start_date <= ${month_end}::date
      AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
    ORDER BY a.assignment_id
  `);

  // Entered freelancer hours for this month, keyed by assignment_id.
  // Used to override allocation-based cost with actual tracked hours
  // — same rule as cumulativeProjectCost, so monthly + cumulative
  // numbers stay in sync. We also surface the hours + source back to
  // the UI so the assignment table can display them next to cost
  // (read-only — the dedicated Freelancer Hours card remains the
  // editing surface).
  const freelancerHoursRes = await db.execute(sql`
    SELECT fte.assignment_id, fte.hours_decimal, fte.source
    FROM freelancer_time_entry fte
    JOIN assignment a ON a.assignment_id = fte.assignment_id
    WHERE a.project_id = ${project_id}
      AND fte.year_month = ${monthYm}
  `);
  const enteredHours = new Map<
    number,
    { hours: Decimal; source: "manual" | "awork" }
  >();
  for (const r of freelancerHoursRes.rows as Array<Record<string, unknown>>) {
    enteredHours.set(r.assignment_id as number, {
      hours: new Decimal(r.hours_decimal as string),
      source: r.source as "manual" | "awork",
    });
  }
  const has_freelancer_hours = enteredHours.size > 0;
  // Total freelancer hours entered for this project × month (across all
  // freelancer assignments). Surfaced as its own field because freelancer
  // hours live in `freelancer_time_entry`, NOT Personio/awork attendance,
  // so they're absent from `tracked_hours` — the agent + UI need both to
  // read a mostly-freelancer project completely.
  let total_freelancer_hours = new Decimal(0);
  for (const v of enteredHours.values()) {
    total_freelancer_hours = total_freelancer_hours.add(v.hours);
  }

  const assignment_rows: Array<Record<string, unknown>> = [];
  let total_revenue = new Decimal(0);
  let total_allocation_revenue = new Decimal(0);
  let total_cost = new Decimal(0);
  let total_burdened_cost = new Decimal(0);
  const weighted_alloc_cache = new Map<number, Decimal>();
  const unpaid_in_month_cache = new Map<number, number>();
  const employee_total_tracked_cache = new Map<number, number>();

  for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
    const asn_id = raw.assignment_id as number;
    const emp_id = (raw.employee_id as number | null) ?? null;
    const fl_id = (raw.freelancer_id as number | null) ?? null;
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
    const role_tier = (raw.role_tier as string | null) ?? null;
    const employee_office = (raw.employee_office as string | null) ?? null;

    const { monthly_cost, who_name, standard_daily_hours } =
      await entityMonthlyCost(emp_id, fl_id, cost_ov, burden, month_start);
    const effective_profile = profile ?? role_tier;
    const fte = emp_id !== null ? await employeeFte(emp_id) : new Decimal(1);

    // Per-employee holiday set: federal + state-specific for the employee's
    // office. Falls back to federal-only for freelancers (no office) and
    // employees with unknown / foreign offices. Local-only holidays
    // (Fronleichnam for Bavaria, Heilige Drei Könige for BW/BY/SA, etc.)
    // are absent from `working_days` (which is federal-only) so we filter
    // them out of `active_days` explicitly below.
    const empStateCode = stateCodeForOffice(employee_office);
    const empHolidays =
      empStateCode === null
        ? holidays
        : germanHolidaysForStateCached(
            empStateCode,
            Number(month_start.slice(0, 4)),
            Number(month_end.slice(0, 4)),
          );

    const a_window_start = a_start > month_start ? a_start : month_start;
    const a_window_end =
      a_end === null ? month_end : a_end < month_end ? a_end : month_end;
    const active_days = working_days.filter(
      (d) =>
        d >= a_window_start && d <= a_window_end && !empHolidays.has(d),
    );

    let absence_set = new Set<string>();
    let unpaid_set = new Set<string>();
    if (emp_id !== null) {
      const [a, u] = await absencesForEmployee(
        emp_id,
        month_start,
        month_end,
        empHolidays,
      );
      absence_set = a;
      unpaid_set = u;
    }
    const absent_active = active_days.filter((d) => absence_set.has(d));
    const unpaid_active = active_days.filter((d) => unpaid_set.has(d));
    const billable_count_calendar = active_days.length - absent_active.length;
    // FTE-prorated billable day equivalents = the actual output in 8h-day
    // units. An 88%-FTE employee (e.g. Christian Szofer at 35h/week) over
    // 21 calendar days works 21 × 0.88 = 18.48 day-units (7h/day, not 8h)
    // — what they actually log in Personio. This is a measure of hours
    // worked, independent of allocation. (`allocation_pct` is separately a
    // fraction of full-time, so committed revenue is `rate × alloc` with
    // no extra × fte — see `allocation_revenue` below.)
    const billable_day_equivs = new Decimal(billable_count_calendar).mul(fte);
    const paid_active_days = active_days.length - unpaid_active.length;

    // Two parallel revenue concepts on T&M:
    //   `allocation_revenue` — `rate × alloc × fte` summed per billable
    //     day. This is the *commitment*: what we'd bill the customer
    //     IF the consultant tracked every allocated hour. Useful for
    //     forward-looking views (forecasts, "expected revenue if
    //     everyone tracks to plan").
    //   `tracked_revenue` (derived below from `avg_rate`) — what the
    //     customer is *actually* invoiced: tracked hours × the prevailing
    //     daily rate. A staffed-but-not-working consultant produces
    //     zero tracked_revenue while still carrying full salary cost,
    //     yielding the correct negative margin.
    // `avg_rate` is the unweighted mean of the resolved rates across
    // billable days. Going through avg_rate (rather than proportioning
    // allocation_revenue by tracked/billable ratio) avoids the
    // alloc-factor under-count that the prior formula exhibited for
    // sub-100% allocations.
    let allocation_revenue = new Decimal(0);
    let rate_unresolved_days = 0;
    let resolved_rate_sum = new Decimal(0);
    let resolved_rate_days = 0;
    if (billing === "time_and_material") {
      for (const day of active_days) {
        if (absence_set.has(day)) continue;
        const r = await resolveRateForDay(
          project_id,
          framework_id,
          effective_profile,
          day,
          rate_ov,
        );
        if (r !== null) {
          // `allocation_pct` is a fraction of full-time, so committed
          // billing = rate × alloc (a fully-booked 88% consultant → alloc
          // 0.875 → bills 7h of an 8h day). No extra × fte, which would
          // double-discount part-timers.
          allocation_revenue = allocation_revenue.add(r.mul(alloc));
          resolved_rate_sum = resolved_rate_sum.add(r);
          resolved_rate_days++;
        } else {
          rate_unresolved_days++;
        }
      }
    }
    const avg_rate =
      resolved_rate_days > 0
        ? resolved_rate_sum.div(resolved_rate_days)
        : null;

    const weighted_alloc_i =
      n_wd > 0 && active_days.length > 0
        ? alloc.mul(active_days.length).div(n_wd)
        : new Decimal(0);

    let cost_share = new Decimal(0);
    const tracked_minutes_this_emp =
      emp_id !== null ? tracked_minutes_per_emp.get(emp_id) ?? 0 : 0;
    const fl_entry = emp_id === null ? enteredHours.get(asn_id) : undefined;
    const fl_entered = fl_entry?.hours;
    if (monthly_cost !== null && n_wd > 0) {
      if (fl_entered !== undefined) {
        // Freelancer with entered tracked hours — actuals win over the
        // allocation-based estimate. cost = hours × (daily_cost / 8).
        const cost_per_hour = monthly_cost
          .div(20)
          .div(standard_daily_hours);
        cost_share = cost_per_hour.mul(fl_entered);
      } else if (has_time_mapping && emp_id !== null) {
        let total_tracked_min = employee_total_tracked_cache.get(emp_id);
        if (total_tracked_min === undefined) {
          total_tracked_min = await employeeTotalTrackedMinutesInMonth(
            emp_id,
            month_start,
            month_end,
          );
          employee_total_tracked_cache.set(emp_id, total_tracked_min);
        }
        const standard_monthly_hours = new Decimal(n_wd).mul(
          standard_daily_hours,
        );
        const total_tracked_hours = new Decimal(total_tracked_min).div(60);
        const denom = total_tracked_hours.gt(standard_monthly_hours)
          ? total_tracked_hours
          : standard_monthly_hours;
        cost_share = monthly_cost
          .mul(new Decimal(tracked_minutes_this_emp).div(60))
          .div(denom);
        if (cost_share.gt(monthly_cost)) cost_share = monthly_cost;
      } else if (emp_id !== null && paid_active_days > 0) {
        // Employee without time-mapping — project cost from allocation.
        // We pay them their salary regardless of whether hours are
        // tracked here, so the projection reads as "what this project
        // would absorb if they delivered the allocation."
        //
        // `allocation_pct` is a fraction of full-time, so a fully-committed
        // part-timer (alloc = fte) absorbs their WHOLE cost on this project.
        // Divide by fte → cost = monthly_cost × (alloc / fte) × active
        // share; otherwise an 88%-contract employee only ever charges 88%
        // of their salary and the remainder reads as spurious bench.
        const paid_weighted_alloc_i = alloc
          .mul(paid_active_days)
          .div(n_wd)
          .div(fte);
        cost_share = monthly_cost.mul(paid_weighted_alloc_i);
        if (cost_share.gt(monthly_cost)) cost_share = monthly_cost;
      }
      // Freelancer with NO entered_hours row: cost_share stays 0.
      // Freelancers are pay-as-they-work — until an entry exists we
      // assume neither billed-them nor billed-the-customer. The
      // project's `n_missing_freelancer_hours_months` flag exists to
      // surface this gap operationally.
    }

    let burdened_share = new Decimal(0);
    if (
      emp_id !== null &&
      monthly_cost !== null &&
      weighted_alloc_i.gt(0)
    ) {
      let total_weighted = weighted_alloc_cache.get(emp_id);
      if (total_weighted === undefined) {
        total_weighted = await employeeWeightedAllocInMonth(
          emp_id,
          month_start,
          month_end,
          working_days,
        );
        weighted_alloc_cache.set(emp_id, total_weighted);
      }
      if (total_weighted.gt(0)) {
        let unpaid_in_month = unpaid_in_month_cache.get(emp_id);
        if (unpaid_in_month === undefined) {
          const [, u] = await absencesForEmployee(
            emp_id,
            month_start,
            month_end,
            holidays,
          );
          unpaid_in_month = u.size;
          unpaid_in_month_cache.set(emp_id, unpaid_in_month);
        }
        const paid_share = new Decimal(n_wd - unpaid_in_month).div(n_wd);
        const effective_monthly_cost = monthly_cost.mul(paid_share);
        burdened_share = effective_monthly_cost
          .mul(weighted_alloc_i)
          .div(total_weighted)
          .mul(elapsed_share);
      }
    } else if (emp_id === null) {
      burdened_share = cost_share;
    }

    const tracked_minutes =
      emp_id !== null ? tracked_minutes_per_emp.get(emp_id) ?? 0 : 0;
    const tracked_hours_rounded = Math.round(tracked_minutes / 60);
    const tracked_days_dec = new Decimal(tracked_hours_rounded).div(8);

    // Direct compute of tracked_revenue from avg_rate × actual logged
    // time. For freelancers, "logged time" is entered hours (we don't
    // get awork/Personio attendance for them); when no hours are
    // entered tracked_revenue stays 0, matching cost above — until an
    // entry exists we assume neither bill nor pay. `allocation_revenue`
    // stays available as the projection sibling so forecast views can
    // still see "if everyone delivered the allocation, this is what
    // we'd bill."
    let tracked_revenue = new Decimal(0);
    if (billing === "time_and_material" && avg_rate !== null) {
      if (emp_id !== null) {
        tracked_revenue = avg_rate.mul(tracked_days_dec);
      } else if (fl_entered !== undefined) {
        const fl_days = fl_entered.div(standard_daily_hours);
        tracked_revenue = avg_rate.mul(fl_days);
      }
    }

    // For T&M the headline revenue is what the customer is invoiced —
    // tracked time × rate, independent of whether the project has a
    // time-mapping configured. A project without time mapping shows
    // zero billable revenue (correct: nothing has been logged) and the
    // cost (allocation-based, since the cost fallback above also kicks
    // in when there's no time mapping) drives the margin into the red,
    // surfacing the staffed-but-not-tracking gap that used to read as
    // healthy positive margin.
    const effective_revenue =
      billing === "time_and_material" ? tracked_revenue : allocation_revenue;

    const margin =
      billing === "time_and_material"
        ? effective_revenue.sub(cost_share)
        : null;
    const burdened_margin =
      billing === "time_and_material"
        ? effective_revenue.sub(burdened_share)
        : null;

    assignment_rows.push({
      assignment_id: asn_id,
      profile: effective_profile,
      allocation_pct: alloc.toFixed(4),
      active_working_days: active_days.length,
      absence_days: absent_active.length,
      billable_days: Number(billable_day_equivs.toFixed(2)),
      rate_unresolved_days,
      kind: emp_id !== null ? "employee" : "freelancer",
      employee_id: emp_id,
      freelancer_id: fl_id,
      assignment_start_date: a_start,
      assignment_end_date: a_end,
      who_name,
      fte: emp_id !== null ? fmt(fte, 3) : null,
      unpaid_absence_days: unpaid_active.length,
      monthly_cost_full: monthly_cost === null ? null : fmt(monthly_cost, 2),
      revenue:
        billing === "time_and_material" ? fmt(effective_revenue, 2) : null,
      allocation_revenue:
        billing === "time_and_material" ? fmt(allocation_revenue, 2) : null,
      cost: fmt(cost_share, 2),
      margin: margin === null ? null : fmt(margin, 2),
      burdened_cost: fmt(burdened_share, 2),
      burdened_margin:
        burdened_margin === null ? null : fmt(burdened_margin, 2),
      tracked_hours:
        emp_id !== null ? tracked_hours_rounded.toFixed(0) : null,
      tracked_days: emp_id !== null ? tracked_days_dec.toFixed(3) : null,
      tracked_revenue:
        billing === "time_and_material" ? fmt(tracked_revenue, 2) : null,
      entered_hours: fl_entered === undefined ? null : fl_entered.toFixed(2),
      entered_hours_source: fl_entry?.source ?? null,
    });

    if (billing === "time_and_material") {
      total_revenue = total_revenue.add(effective_revenue);
      total_allocation_revenue =
        total_allocation_revenue.add(allocation_revenue);
    }
    total_cost = total_cost.add(cost_share);
    total_burdened_cost = total_burdened_cost.add(burdened_share);
  }

  const unassigned_tracked = await unassignedTrackedForProject(
    project_id,
    framework_id,
    month_start,
    month_end,
    n_wd,
    billing,
    burden,
  );
  for (const u of unassigned_tracked) {
    if (u.revenue) total_revenue = total_revenue.add(u.revenue as string);
    if (u.cost) {
      total_cost = total_cost.add(u.cost as string);
      total_burdened_cost = total_burdened_cost.add(u.cost as string);
    }
  }

  const total_margin =
    billing === "time_and_material" ? total_revenue.sub(total_cost) : null;
  const margin_pct =
    total_margin !== null && total_revenue.gt(0)
      ? total_margin.div(total_revenue).mul(100)
      : null;
  const total_burdened_margin =
    billing === "time_and_material"
      ? total_revenue.sub(total_burdened_cost)
      : null;
  const burdened_margin_pct =
    total_burdened_margin !== null && total_revenue.gt(0)
      ? total_burdened_margin.div(total_revenue).mul(100)
      : null;

  let cumulative_cost: Decimal | null = null;
  let cumulative_burdened_cost: Decimal | null = null;
  let remaining_budget: Decimal | null = null;
  let recognized_revenue: Decimal | null = null;
  let recognized_margin: Decimal | null = null;
  let recognized_margin_pct: Decimal | null = null;
  let cumulative_recognized: Decimal | null = null;
  // Unified lifetime revenue for the lifetime box — FP uses recognized
  // revenue, T&M uses tracked-hours × rate (cumulativeProjectRevenue).
  let cumulative_revenue: Decimal | null = null;
  let cumulative_margin: Decimal | null = null;
  let cumulative_margin_pct: Decimal | null = null;
  let cumulative_burdened_margin: Decimal | null = null;
  let cumulative_burdened_margin_pct: Decimal | null = null;
  let pct_complete: Decimal | null = null;
  let recognition_method: "tracked_hours" | "timeline" | "none" | null = null;
  let over_budget = false;
  // SDM-facing additions: lifetime tracked hours (across all months),
  // future planned hours (from today to planned_end), and projected
  // end-of-project cost/margin in both allocated and burdened bases.
  // Projection uses the average past cost-per-tracked-hour × future
  // planned hours as the simplest defensible directional estimate;
  // exact future cost would need per-employee future iteration which
  // adds compute for diminishing precision.
  let tracked_hours_lifetime: Decimal | null = null;
  let projected_cost: Decimal | null = null;
  let projected_burdened_cost: Decimal | null = null;
  let projected_margin: Decimal | null = null;
  let projected_margin_pct: Decimal | null = null;
  let projected_burdened_margin: Decimal | null = null;
  let projected_burdened_margin_pct: Decimal | null = null;
  // Future planned hours from today through planned_end — useful for
  // both FP (budget projection) and T&M (forward-look revenue + ending
  // assignments preview). Project may have no planned_end (open-ended
  // T&M); the helper returns 0 in that case so the UI hides the section.
  const future_planned_hours_for_proj = await projectFuturePlannedHours(
    project_id,
    new Date().toISOString().slice(0, 10),
    planned_end,
  );
  let future_planned_hours: Decimal | null = future_planned_hours_for_proj;

  if (billing === "fixed_price") {
    cumulative_cost = await cumulativeProjectCost(
      project_id,
      month_end,
      burden,
    );
    cumulative_burdened_cost = await cumulativeProjectBurdenedCost(
      project_id,
      month_end,
      burden,
    );
    if (agreed_amount !== null) {
      remaining_budget = agreed_amount.sub(cumulative_cost);
    }
    const prev_end = shiftDay(month_start, -1);
    const now = await fpRecognitionThrough(
      project_id,
      month_end,
      agreed_amount,
      time_budget_hours,
      planned_start,
      planned_end,
    );
    recognition_method = now.method;
    over_budget = now.over_budget;
    if (now.cumulative_recognized !== null) {
      cumulative_recognized = now.cumulative_recognized;
      const prev = await fpRecognitionThrough(
        project_id,
        prev_end,
        agreed_amount,
        time_budget_hours,
        planned_start,
        planned_end,
      );
      const prev_cum = prev.cumulative_recognized ?? new Decimal(0);
      recognized_revenue = cumulative_recognized.sub(prev_cum);
      recognized_margin = recognized_revenue.sub(total_cost);
      if (recognized_revenue.gt(0)) {
        recognized_margin_pct = recognized_margin
          .div(recognized_revenue)
          .mul(100);
      }
      pct_complete = now.pct_complete_raw;
      cumulative_margin = cumulative_recognized.sub(cumulative_cost);
      if (cumulative_recognized.gt(0)) {
        cumulative_margin_pct = cumulative_margin
          .div(cumulative_recognized)
          .mul(100);
      }
      if (cumulative_burdened_cost !== null) {
        cumulative_burdened_margin = cumulative_recognized.sub(
          cumulative_burdened_cost,
        );
        if (cumulative_recognized.gt(0)) {
          cumulative_burdened_margin_pct = cumulative_burdened_margin
            .div(cumulative_recognized)
            .mul(100);
        }
      }
    }

    // Lifetime tracked hours through today + projected cost and
    // margin (allocated and burdened). FP-specific because the
    // projection assumes an end date and a tracked-hours rate basis.
    // Future planned hours move OUT of this block below since T&M
    // wants them too for its forward-look.
    const today_iso = new Date().toISOString().slice(0, 10);
    tracked_hours_lifetime = await projectTrackedHoursThrough(
      project_id,
      today_iso,
    );

    // Project cost forward: average past cost-per-hour × future planned.
    // Only attempt when we have a non-trivial denominator; otherwise
    // the projected fields stay null and the UI hides them.
    if (
      cumulative_cost !== null &&
      tracked_hours_lifetime.gt(0) &&
      future_planned_hours.gt(0)
    ) {
      const avg_cost_per_hour = cumulative_cost.div(tracked_hours_lifetime);
      projected_cost = cumulative_cost.add(
        avg_cost_per_hour.mul(future_planned_hours),
      );
      if (agreed_amount !== null) {
        projected_margin = agreed_amount.sub(projected_cost);
        if (agreed_amount.gt(0)) {
          projected_margin_pct = projected_margin
            .div(agreed_amount)
            .mul(100);
        }
      }
    }
    if (
      cumulative_burdened_cost !== null &&
      tracked_hours_lifetime.gt(0) &&
      future_planned_hours.gt(0)
    ) {
      const avg_burdened_per_hour = cumulative_burdened_cost.div(
        tracked_hours_lifetime,
      );
      projected_burdened_cost = cumulative_burdened_cost.add(
        avg_burdened_per_hour.mul(future_planned_hours),
      );
      if (agreed_amount !== null) {
        projected_burdened_margin = agreed_amount.sub(projected_burdened_cost);
        if (agreed_amount.gt(0)) {
          projected_burdened_margin_pct = projected_burdened_margin
            .div(agreed_amount)
            .mul(100);
        }
      }
    }
  } else {
    // T&M lifetime aggregates for the lifetime box. FP computes these in
    // the block above (recognized revenue basis); T&M's lifetime revenue
    // is tracked-hours × rate. Cost + burdened cost + tracked hours reuse
    // the same billing-model-agnostic helpers the FP path uses, so the
    // lifetime numbers reconcile with the monthly views.
    const today_iso = new Date().toISOString().slice(0, 10);
    cumulative_cost = await cumulativeProjectCost(project_id, month_end, burden);
    cumulative_burdened_cost = await cumulativeProjectBurdenedCost(
      project_id,
      month_end,
      burden,
    );
    tracked_hours_lifetime = await projectTrackedHoursThrough(
      project_id,
      today_iso,
    );
    cumulative_revenue = await cumulativeProjectRevenue(project_id, today_iso);
    cumulative_margin = cumulative_revenue.sub(cumulative_cost);
    if (cumulative_revenue.gt(0)) {
      cumulative_margin_pct = cumulative_margin
        .div(cumulative_revenue)
        .mul(100);
    }
    cumulative_burdened_margin = cumulative_revenue.sub(cumulative_burdened_cost);
    if (cumulative_revenue.gt(0)) {
      cumulative_burdened_margin_pct = cumulative_burdened_margin
        .div(cumulative_revenue)
        .mul(100);
    }
  }

  // Unify the lifetime revenue field: FP recognizes revenue; T&M tracks it.
  if (cumulative_revenue === null) cumulative_revenue = cumulative_recognized;
  // Person-days tracked over the project lifetime (8h/day convention).
  const lifetime_tracked_person_days =
    tracked_hours_lifetime === null ? null : tracked_hours_lifetime.div(8);

  const total_rate_unresolved =
    assignment_rows.reduce(
      (a, r) => a + (r.rate_unresolved_days as number),
      0,
    ) +
    unassigned_tracked.reduce(
      (a, u) => a + ((u.rate_unresolved_days as number) ?? 0),
      0,
    );
  const total_tracked_hours =
    assignment_rows.reduce(
      (a, r) =>
        a + (r.tracked_hours ? Number(r.tracked_hours as string) : 0),
      0,
    ) +
    unassigned_tracked.reduce(
      (a, u) => a + Number(u.tracked_hours as string),
      0,
    );
  const total_tracked_days_dec = assignment_rows
    .reduce(
      (acc, r) =>
        r.tracked_days ? acc.add(r.tracked_days as string) : acc,
      new Decimal(0),
    )
    .add(
      unassigned_tracked.reduce(
        (acc, u) => acc.add(u.tracked_days as string),
        new Decimal(0),
      ),
    );
  const total_tracked_revenue_dec = assignment_rows
    .reduce(
      (acc, r) =>
        r.tracked_revenue ? acc.add(r.tracked_revenue as string) : acc,
      new Decimal(0),
    )
    .add(
      unassigned_tracked.reduce(
        (acc, u) =>
          u.revenue ? acc.add(u.revenue as string) : acc,
        new Decimal(0),
      ),
    );

  return {
    project_id,
    project_name,
    billing_model: billing,
    month: monthYm,
    month_start,
    month_end,
    working_days_in_month: n_wd,
    working_days_elapsed,
    month_status,
    time_budget_hours: time_budget_hours,
    planned_start_date: planned_start,
    planned_end_date: planned_end,
    agreed_amount_eur:
      agreed_amount === null ? null : fmt(agreed_amount, 2),
    revenue:
      billing === "time_and_material" ? fmt(total_revenue, 2) : null,
    allocation_revenue:
      billing === "time_and_material"
        ? fmt(total_allocation_revenue, 2)
        : null,
    cost: fmt(total_cost, 2),
    margin: total_margin === null ? null : fmt(total_margin, 2),
    margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
    burdened_cost: fmt(total_burdened_cost, 2),
    burdened_margin:
      total_burdened_margin === null ? null : fmt(total_burdened_margin, 2),
    burdened_margin_pct:
      burdened_margin_pct === null ? null : fmt(burdened_margin_pct, 2),
    cumulative_cost:
      cumulative_cost === null ? null : fmt(cumulative_cost, 2),
    remaining_budget:
      remaining_budget === null ? null : fmt(remaining_budget, 2),
    recognized_revenue:
      recognized_revenue === null ? null : fmt(recognized_revenue, 2),
    recognized_margin:
      recognized_margin === null ? null : fmt(recognized_margin, 2),
    recognized_margin_pct:
      recognized_margin_pct === null
        ? null
        : fmt(recognized_margin_pct, 2),
    cumulative_recognized_revenue:
      cumulative_recognized === null
        ? null
        : fmt(cumulative_recognized, 2),
    cumulative_margin:
      cumulative_margin === null ? null : fmt(cumulative_margin, 2),
    cumulative_margin_pct:
      cumulative_margin_pct === null
        ? null
        : fmt(cumulative_margin_pct, 2),
    cumulative_burdened_cost:
      cumulative_burdened_cost === null
        ? null
        : fmt(cumulative_burdened_cost, 2),
    cumulative_burdened_margin:
      cumulative_burdened_margin === null
        ? null
        : fmt(cumulative_burdened_margin, 2),
    cumulative_burdened_margin_pct:
      cumulative_burdened_margin_pct === null
        ? null
        : fmt(cumulative_burdened_margin_pct, 2),
    // Unified lifetime revenue (FP: recognized; T&M: tracked × rate) + the
    // person-days figure — power the lifetime box for both billing models.
    cumulative_revenue:
      cumulative_revenue === null ? null : fmt(cumulative_revenue, 2),
    lifetime_tracked_person_days:
      lifetime_tracked_person_days === null
        ? null
        : fmt(lifetime_tracked_person_days, 1),
    tracked_hours_lifetime:
      tracked_hours_lifetime === null
        ? null
        : fmt(tracked_hours_lifetime, 2),
    future_planned_hours:
      future_planned_hours === null ? null : fmt(future_planned_hours, 2),
    projected_cost: projected_cost === null ? null : fmt(projected_cost, 2),
    projected_burdened_cost:
      projected_burdened_cost === null
        ? null
        : fmt(projected_burdened_cost, 2),
    projected_margin:
      projected_margin === null ? null : fmt(projected_margin, 2),
    projected_margin_pct:
      projected_margin_pct === null ? null : fmt(projected_margin_pct, 2),
    projected_burdened_margin:
      projected_burdened_margin === null
        ? null
        : fmt(projected_burdened_margin, 2),
    projected_burdened_margin_pct:
      projected_burdened_margin_pct === null
        ? null
        : fmt(projected_burdened_margin_pct, 2),
    pct_complete: pct_complete === null ? null : fmt(pct_complete, 4),
    recognition_method,
    over_budget,
    rate_unresolved_days: total_rate_unresolved,
    tracked_hours: total_tracked_hours.toFixed(0),
    tracked_days: total_tracked_days_dec.toFixed(3),
    tracked_revenue:
      billing === "time_and_material"
        ? total_tracked_revenue_dec.toFixed(2)
        : null,
    has_personio_mapping: has_time_mapping,
    has_freelancer_hours,
    freelancer_hours: total_freelancer_hours.toFixed(2),
    assignments: assignment_rows,
    unassigned_tracked,
  };
}
