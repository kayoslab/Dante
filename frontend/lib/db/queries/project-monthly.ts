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
  employeeFte,
  employeeTotalTrackedMinutesInMonth,
  employeeWeightedAllocInMonth,
  entityMonthlyCost,
  fmt,
  fpRecognitionThrough,
  holidaysForYearOf,
  lastOfMonth,
  projectHasTimeMapping,
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
  customer_name: string;
};

/** All active projects with their customer name, ordered the way the
 * portfolio page expects (customer asc, project asc). Used by
 * `/api/portfolio/monthly` to fan out per-project breakdowns. */
export async function listActiveProjectsForPortfolio(): Promise<
  ActiveProjectRow[]
> {
  const r = await db.execute(sql`
    SELECT p.project_id, p.name, p.billing_model, c.name AS customer_name
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.status = 'active'
    ORDER BY c.name, p.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    project_id: row.project_id as number,
    name: row.name as string,
    billing_model: row.billing_model as string,
    customer_name: row.customer_name as string,
  }));
}

export type UnallocatedPayrollEmployeeRow = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  hire_date: string | null;
  employment_end_date: string | null;
  team: string | null;
  is_real: boolean;
};

/** Active, real, project-contributing employees whose contract overlaps
 * the given month. Drives the bench / unallocated-payroll summary on
 * `/api/portfolio/monthly`. */
export async function listUnallocatedPayrollEmployees(
  month_start: string,
  month_end: string,
): Promise<UnallocatedPayrollEmployeeRow[]> {
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.hire_date, ec.employment_end_date,
           COALESCE(ann.team_user, ec.department) AS team,
           COALESCE(ann.is_real_employee, TRUE) AS is_real
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${month_end}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${month_start}::date)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
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

  const assignment_rows: Array<Record<string, unknown>> = [];
  let total_revenue = new Decimal(0);
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
      await entityMonthlyCost(emp_id, fl_id, cost_ov, burden);
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
    // FTE-prorated billable day equivalents. An employee on 88% FTE
    // (e.g. Christian Szofer at 35h/week) spending 21 calendar days on
    // a project bills the customer for 21 × 0.88 = 18.48 day-units of
    // work — which is what they would actually log in Personio (7h/day
    // instead of 8h). The display, the tracked-vs-billable variance
    // colouring in `<TrackedCell>` and the `tracked_revenue`
    // proration all need this FTE-adjusted figure; otherwise an 88%
    // consultant tracking their full hours looks 12% under-billed.
    // Revenue itself is already FTE-prorated via `r.mul(alloc).mul(fte)`
    // below, so the denominator we use for tracked_revenue must match
    // or we double-discount.
    const billable_day_equivs = new Decimal(billable_count_calendar).mul(fte);
    const paid_active_days = active_days.length - unpaid_active.length;

    let revenue = new Decimal(0);
    let rate_unresolved_days = 0;
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
          revenue = revenue.add(r.mul(alloc).mul(fte));
        } else {
          rate_unresolved_days++;
        }
      }
    }

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
      } else if (paid_active_days > 0) {
        const paid_weighted_alloc_i = alloc
          .mul(paid_active_days)
          .div(n_wd);
        cost_share = monthly_cost.mul(paid_weighted_alloc_i);
      }
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

    let tracked_revenue = new Decimal(0);
    if (
      billing === "time_and_material" &&
      billable_day_equivs.gt(0) &&
      revenue.gt(0) &&
      tracked_days_dec.gt(0)
    ) {
      tracked_revenue = revenue.mul(tracked_days_dec).div(billable_day_equivs);
    }

    const effective_revenue =
      has_time_mapping && emp_id !== null && billing === "time_and_material"
        ? tracked_revenue
        : revenue;

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
      who_name,
      fte: emp_id !== null ? fmt(fte, 3) : null,
      unpaid_absence_days: unpaid_active.length,
      monthly_cost_full: monthly_cost === null ? null : fmt(monthly_cost, 2),
      revenue:
        billing === "time_and_material" ? fmt(effective_revenue, 2) : null,
      cost: fmt(cost_share, 2),
      margin: margin === null ? null : fmt(margin, 2),
      burdened_cost: fmt(burdened_share, 2),
      burdened_margin:
        burdened_margin === null ? null : fmt(burdened_margin, 2),
      tracked_hours:
        emp_id !== null ? tracked_hours_rounded.toFixed(0) : null,
      tracked_days: emp_id !== null ? tracked_days_dec.toFixed(3) : null,
      tracked_revenue:
        billing === "time_and_material" && emp_id !== null
          ? fmt(tracked_revenue, 2)
          : null,
      entered_hours: fl_entered === undefined ? null : fl_entered.toFixed(2),
      entered_hours_source: fl_entry?.source ?? null,
    });

    if (billing === "time_and_material") {
      total_revenue = total_revenue.add(effective_revenue);
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
  let cumulative_margin: Decimal | null = null;
  let cumulative_margin_pct: Decimal | null = null;
  let cumulative_burdened_margin: Decimal | null = null;
  let cumulative_burdened_margin_pct: Decimal | null = null;
  let pct_complete: Decimal | null = null;
  let recognition_method: "tracked_hours" | "timeline" | "none" | null = null;
  let over_budget = false;
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
  }

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
    agreed_amount_eur:
      agreed_amount === null ? null : fmt(agreed_amount, 2),
    revenue:
      billing === "time_and_material" ? fmt(total_revenue, 2) : null,
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
    assignments: assignment_rows,
    unassigned_tracked,
  };
}
