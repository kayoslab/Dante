/** Per-employee, per-month profitability breakdown.
 *
 * Source of truth for `/api/employees/[id]/monthly` and the series
 * route. Pure data — no audit or auth. The route handler audits at
 * the request boundary so a series view logs once for the series, not
 * once per month. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  germanHolidaysForStateCached,
  stateCodeForOffice,
} from "../_de-holidays";
import {
  absenceWeightOverDays,
  absencesForEmployee,
  burdenFactor,
  employeeFte,
  employeeTrackedUtilizationInMonth,
  entityMonthlyCost,
  fmt,
  fpRecognizedRevenueForMonth,
  holidaysForYearOf,
  lastOfMonth,
  projectTotalWeightedAllocInMonth,
  loadRateResolver,
  trackedMinutesByProjectForEmployee,
  workingDaysInRange,
} from "../_monthly-helpers";

export type EmployeeMonthlyBreakdown = Record<string, unknown> & {
  entity_kind: "employee";
  entity_id: number;
  month: string;
  assignments: Array<Record<string, unknown>>;
};

/** Returns null when the employee row doesn't exist; the route maps to 404. */
export async function computeEmployeeMonthly(
  employee_id: number,
  monthYm: string,
): Promise<EmployeeMonthlyBreakdown | null> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);

  const empRes = await db.execute(sql`
    SELECT ec.first_name, ec.last_name, ec.status,
           COALESCE(a.is_real_employee, TRUE) AS is_real,
           ec.hire_date, ec.employment_end_date, ec.office
    FROM employee_current ec
    LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
    WHERE ec.employee_id = ${employee_id}
  `);
  const empRow = (empRes.rows as Array<Record<string, unknown>>)[0];
  if (!empRow) return null;

  const first_name = empRow.first_name as string | null;
  const last_name = empRow.last_name as string | null;
  const status = empRow.status as string | null;
  const is_real = empRow.is_real as boolean;
  const hire_date = (empRow.hire_date as string | null) ?? null;
  const end_date = (empRow.employment_end_date as string | null) ?? null;
  const office = (empRow.office as string | null) ?? null;
  const who_name = `${first_name ?? ""} ${last_name ?? ""}`;

  // Per-employee holiday set: federal + state-specific for the office.
  // The project month's `working_days` stays federal-only (so it's
  // comparable across employees on the same project), but this set is
  // what we filter `active_days` and absences against — so a Bavarian
  // doesn't show as billable on Fronleichnam.
  const stateCode = stateCodeForOffice(office);
  const holidays =
    stateCode === null
      ? holidaysForYearOf(month_start)
      : germanHolidaysForStateCached(
          stateCode,
          Number(month_start.slice(0, 4)),
          Number(month_end.slice(0, 4)),
        );
  const working_days = workingDaysInRange(month_start, month_end, holidays);
  const n_wd = working_days.length;
  const burden = await burdenFactor();

  let under_contract = true;
  if (hire_date !== null && month_end < hire_date) under_contract = false;
  if (end_date !== null && month_start > end_date) under_contract = false;

  if (!under_contract) {
    const basis =
      hire_date !== null
        ? `not under contract (hired ${hire_date}` +
          (end_date !== null ? `, left ${end_date}` : "") +
          ")"
        : "not under contract";
    return {
      entity_kind: "employee",
      entity_id: employee_id,
      who_name,
      status,
      is_real_employee: Boolean(is_real),
      month: monthYm,
      month_start,
      month_end,
      working_days_in_month: n_wd,
      monthly_cost_full: null,
      monthly_cost_basis: basis,
      revenue: "0.00",
      allocation_revenue: "0.00",
      margin: "0.00",
      margin_pct: null,
      utilization_pct: "0.0000",
      tracked_utilization_pct: null,
      fte: "0.000",
      rate_unresolved_days: 0,
      assignments: [],
      under_contract: false,
      hire_date,
      employment_end_date: end_date,
      // resolved_salary deliberately null here — the question was about
      // whether the row was contractually relevant, not what they earn.
      resolved_salary: null,
    };
  }

  const {
    monthly_cost: monthly_cost_full,
    basis: cost_basis,
    standard_daily_hours,
    resolved_salary,
  } = await entityMonthlyCost(employee_id, null, null, burden, month_start);

  const contract_clipped_start =
    hire_date !== null && hire_date > month_start ? hire_date : month_start;
  const contract_clipped_end =
    end_date !== null && end_date < month_end ? end_date : month_end;
  const contract_workdays = working_days.filter(
    (d) => d >= contract_clipped_start && d <= contract_clipped_end,
  );
  const contract_share =
    n_wd > 0
      ? new Decimal(contract_workdays.length).div(n_wd)
      : new Decimal(1);
  let monthly_cost_prorated =
    monthly_cost_full !== null
      ? monthly_cost_full.mul(contract_share)
      : null;
  let cost_basis_prorated = cost_basis;
  if (monthly_cost_full !== null && contract_share.lt(1)) {
    cost_basis_prorated = `${cost_basis} · prorated to ${contract_workdays.length}/${n_wd} workdays under contract`;
  }

  const fte = await employeeFte(employee_id);
  const [absences, unpaid_absences] = await absencesForEmployee(
    employee_id,
    month_start,
    month_end,
    holidays,
  );

  // Weighted count — half-day absences contribute 0.5 (see absencesForEmployee).
  const unpaid_in_contract = absenceWeightOverDays(
    unpaid_absences,
    contract_workdays,
  );
  if (
    unpaid_in_contract > 0 &&
    monthly_cost_prorated !== null &&
    contract_workdays.length > 0
  ) {
    const unpaid_share = new Decimal(
      contract_workdays.length - unpaid_in_contract,
    ).div(contract_workdays.length);
    monthly_cost_prorated = monthly_cost_prorated.mul(unpaid_share);
    const days_label = Number(unpaid_in_contract.toFixed(1));
    const plural = days_label === 1 ? "" : "s";
    cost_basis_prorated = `${cost_basis_prorated} · ${days_label} unpaid leave day${plural} excluded`;
  }

  const asnRes = await db.execute(sql`
    SELECT a.assignment_id, a.project_id, p.name AS project_name, c.name AS customer_name,
           p.billing_model, p.framework_id, a.profile,
           a.allocation_pct, a.start_date, a.end_date,
           a.daily_rate_override_eur,
           rt.role_tier
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN employee_role_tier rt ON rt.employee_id = a.employee_id
    WHERE a.employee_id = ${employee_id}
      AND a.start_date <= ${month_end}::date
      AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
    ORDER BY a.assignment_id
  `);

  const assignment_rows: Array<Record<string, unknown>> = [];
  let total_revenue = new Decimal(0);
  let total_allocation_revenue = new Decimal(0);
  let total_alloc_weighted = new Decimal(0);
  const project_weighted_cache = new Map<number, Decimal>();
  // Tracked minutes per project for THIS employee in THIS month. T&M
  // revenue per assignment is `avg_rate × (project_tracked / 8h)`,
  // independent of allocation. A consultant staffed but not working
  // contributes zero revenue here while their salary cost still
  // counts at the employee level, so the per-employee margin drops
  // into the red — matching the project-engine fix.
  const tracked_by_project = await trackedMinutesByProjectForEmployee(
    employee_id,
    month_start,
    month_end,
  );

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
    const role_tier = raw.role_tier as string | null;
    const effective_profile = profile ?? role_tier;

    const a_window_start = a_start > month_start ? a_start : month_start;
    const a_window_end =
      a_end === null ? month_end : a_end < month_end ? a_end : month_end;
    const active_days = working_days.filter(
      (d) => d >= a_window_start && d <= a_window_end,
    );
    // Weighted absent days — half-days count 0.5.
    const absent_active = absenceWeightOverDays(absences, active_days);
    // Billable day-equivalents = calendar billable days × FTE (an 88%-FTE
    // consultant works 7h not 8h/day, so 21 calendar days = 18.48 8h-day
    // units). This is a measure of actual output in 8h-days and is
    // independent of allocation.
    const billable_count_calendar = active_days.length - absent_active;
    const billable_day_equivs = new Decimal(billable_count_calendar).mul(fte);
    const weighted_alloc_i =
      n_wd > 0 ? alloc.mul(active_days.length).div(n_wd) : new Decimal(0);
    total_alloc_weighted = total_alloc_weighted.add(weighted_alloc_i);

    // T&M revenue = avg daily rate × tracked days on THIS project for
    // THIS employee — see the matching block in project-monthly.ts.
    // allocation_revenue is the forward-looking sibling (allocation ×
    // rate × billable days); both are reported per assignment so
    // forecast / commitment views can keep using the allocation
    // basis.
    let revenue = new Decimal(0);
    let allocation_revenue = new Decimal(0);
    let rate_unresolved_days = 0;
    let resolved_rate_sum = new Decimal(0);
    let resolved_rate_days = 0;
    if (billing === "time_and_material") {
      // Rates preloaded once per assignment instead of 1–2 queries per day.
      const resolveRate = await loadRateResolver(project_id, framework_id);
      for (const day of active_days) {
        // Fraction of the day actually workable — a half-day absence still
        // bills half the committed allocation (mirrors project-monthly).
        const workable = 1 - (absences.get(day) ?? 0);
        if (workable <= 0) continue;
        const r = resolveRate(effective_profile, day, rate_ov);
        if (r !== null) {
          // `allocation_pct` is a fraction of full-time, so a day's
          // committed billing = rate × alloc (an 88%-contract consultant
          // fully booked → alloc 0.875 → bills 7h of an 8h day). No extra
          // × fte — that would double-discount part-timers.
          allocation_revenue = allocation_revenue.add(
            r.mul(alloc).mul(workable),
          );
          resolved_rate_sum = resolved_rate_sum.add(r);
          resolved_rate_days++;
        } else {
          rate_unresolved_days++;
        }
      }
      if (resolved_rate_days > 0) {
        const avg_rate = resolved_rate_sum.div(resolved_rate_days);
        const tracked_min = tracked_by_project.get(project_id) ?? 0;
        const tracked_days_dec = new Decimal(tracked_min).div(60).div(8);
        revenue = avg_rate.mul(tracked_days_dec);
      }
    } else {
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
      allocation_revenue = revenue;
    }

    assignment_rows.push({
      assignment_id: asn_id,
      profile: effective_profile,
      allocation_pct: alloc.toFixed(4),
      active_working_days: active_days.length,
      absence_days: Number(absent_active.toFixed(1)),
      billable_days: Number(billable_day_equivs.toFixed(2)),
      rate_unresolved_days,
      assignment_start_date: a_start,
      assignment_end_date: a_end,
      project_id,
      project_name,
      customer_name,
      billing_model: billing,
      revenue: fmt(revenue, 2),
      allocation_revenue: fmt(allocation_revenue, 2),
      tracked_hours: ((tracked_by_project.get(project_id) ?? 0) / 60).toFixed(2),
    });
    total_revenue = total_revenue.add(revenue);
    total_allocation_revenue = total_allocation_revenue.add(allocation_revenue);
  }

  const monthly_cost_dec = monthly_cost_prorated ?? new Decimal(0);
  const margin = total_revenue.sub(monthly_cost_dec);
  const margin_pct = monthly_cost_dec.gt(0)
    ? margin.div(monthly_cost_dec).mul(100)
    : null;
  // Utilization is measured against the employee's FTE: `allocation_pct`
  // is a fraction of full-time, so a fully-booked part-timer's weighted
  // allocation equals their FTE and should read as 100%, not their FTE %.
  const utilization = total_alloc_weighted.gt(0)
    ? Number(total_alloc_weighted.div(fte).toString())
    : 0;
  const total_rate_unresolved = assignment_rows.reduce(
    (a, r) => a + (r.rate_unresolved_days as number),
    0,
  );

  // Tracked-time-derived utilization (sibling to the assignment-based
  // number above). Same denominator the bench cost uses — contract-clipped
  // workdays minus absences, multiplied by standard daily hours — so the
  // two metrics live on the same axis and divergence reads as
  // "alloc records don't match the time that was logged."
  const tracked_utilization = await employeeTrackedUtilizationInMonth(
    employee_id,
    month_start,
    month_end,
    contract_workdays,
    absences,
    standard_daily_hours,
  );

  return {
    entity_kind: "employee",
    entity_id: employee_id,
    who_name,
    status,
    is_real_employee: Boolean(is_real),
    month: monthYm,
    month_start,
    month_end,
    working_days_in_month: n_wd,
    monthly_cost_full:
      monthly_cost_prorated === null ? null : fmt(monthly_cost_prorated, 2),
    monthly_cost_basis: cost_basis_prorated,
    revenue: fmt(total_revenue, 2),
    allocation_revenue: fmt(total_allocation_revenue, 2),
    margin: fmt(margin, 2),
    margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
    utilization_pct: utilization.toFixed(4),
    tracked_utilization_pct:
      tracked_utilization === null ? null : fmt(tracked_utilization, 4),
    fte: fmt(fte, 3),
    rate_unresolved_days: total_rate_unresolved,
    assignments: assignment_rows,
    under_contract: true,
    hire_date,
    employment_end_date: end_date,
    resolved_salary,
  };
}
