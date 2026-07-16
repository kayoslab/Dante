import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  absencesForEmployee,
  addMonths,
  employeeWeightedAllocInMonth,
  firstOfMonth,
  holidaysForYearOf,
  lastOfMonth,
  workingDaysInRange,
} from "../_monthly-helpers";
import { roleTierFromAlias } from "../_sql-fragments";
import { getTrackedHoursForMonth } from "./tracked-hours";
import {
  capacitySplit,
  plannedHours,
  projectAssumed,
  realizationRatio,
} from "./_forecast-math";

// ---------------------------------------------------------------------------
// Forecast report — engine + shaped read.
//
// Backs `/reports/forecast` (manager-only). Two things:
//
//  1. Realization: are we delivering the plan this month? Planned allocation
//     (a fraction of FTE, from `assignment`) is converted to planned HOURS so
//     it's comparable to actual tracked hours. Realization ratio = actual
//     worked to-date ÷ planned to-date, computed PER rollup level, applied to
//     the full month ("assumed") and the next two months ("projected").
//
//  2. Capacity breakdown: per team, per month, decompose PAID capacity into
//     planned allocation + paid vacation + intercontract (bench). Unpaid
//     leave (sabbatical / parental) is removed from capacity entirely — it
//     doesn't load payroll. Reported in hours; the client derives FTE and %.
//
// Realization absorbs absences implicitly (time off → lower actual → lower
// ratio); the capacity breakdown makes planned time off explicit.
// ---------------------------------------------------------------------------

const D0 = new Decimal(0);
const FUTURE_MONTHS = 2;
/** A full-time day. `allocation_pct` is a fraction of full-time (40h/8h-day
 * — the awork sync divides planned hours by an 8h day), so planned HOURS =
 * allocation × 8 × working-days, independent of the employee's own daily
 * hours. Capacity/vacation, by contrast, use the employee's ACTUAL daily
 * hours (weekly_working_hours ÷ 5) — so a fully-booked part-timer's planned
 * hours equal their capacity and bench is 0. FTE denominator on the client
 * is the same (hours ÷ wd ÷ 8). */
const FULL_TIME_DAILY = new Decimal(8);

/** hours as a plain number, rounded to 2 dp (display formats to 1). */
function hrs(d: Decimal): number {
  return Number(d.toFixed(2));
}

type EligibleEmployee = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  weekly_working_hours: number | null;
  hire_date: string | null;
  employment_end_date: string | null;
  team: string | null;
  role_tier: string | null;
};

/** Active, real, project-contributing employees whose contract overlaps the
 * forecast window [current month start, +2 month end]. Same eligibility as
 * the utilization engine, plus `weekly_working_hours` (→ daily hours) and the
 * contract dates (→ capacity clipping). */
async function listForecastEligible(
  window_start: string,
  window_end: string,
): Promise<EligibleEmployee[]> {
  const roleTier = roleTierFromAlias("ec", "ann");
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.weekly_working_hours, ec.hire_date, ec.employment_end_date,
           COALESCE(ann.team_user, ec.department) AS team,
           ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      -- Include onboarding (future-start) hires so a joiner adds capacity to
      -- the forecast months they've started; the hire_date window scopes them.
      AND ec.status IN ('active', 'onboarding')
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${window_end}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${window_start}::date)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    weekly_working_hours:
      row.weekly_working_hours === null || row.weekly_working_hours === undefined
        ? null
        : Number(row.weekly_working_hours),
    hire_date: (row.hire_date as string | null) ?? null,
    employment_end_date: (row.employment_end_date as string | null) ?? null,
    team: (row.team as string | null) ?? null,
    role_tier: (row.role_tier as string | null) ?? null,
  }));
}

type MonthWindow = {
  month: string;
  start: string;
  end: string;
  wd: string[];
  holidays: Map<string, string>;
};

function monthWindow(monthStart: string): MonthWindow {
  const end = lastOfMonth(monthStart);
  const holidays = holidaysForYearOf(monthStart);
  const wd = workingDaysInRange(monthStart, end, holidays);
  return { month: monthStart.slice(0, 7), start: monthStart, end, wd, holidays };
}

// ---------------------------------------------------------------------------
// Realization rollups (totals / team / role tier / consultant)
// ---------------------------------------------------------------------------

type EmployeeForecast = {
  planned_full: Decimal;
  planned_to_date: Decimal;
  actual: Decimal;
  billable: Decimal;
  next: Decimal[];
};

type Acc = {
  n: number;
  planned_full: Decimal;
  planned_to_date: Decimal;
  actual: Decimal;
  billable: Decimal;
  next: Decimal[];
};

function newAcc(): Acc {
  return {
    n: 0,
    planned_full: D0,
    planned_to_date: D0,
    actual: D0,
    billable: D0,
    next: Array.from({ length: FUTURE_MONTHS }, () => D0),
  };
}

function addToAcc(acc: Acc, e: EmployeeForecast): void {
  acc.n += 1;
  acc.planned_full = acc.planned_full.add(e.planned_full);
  acc.planned_to_date = acc.planned_to_date.add(e.planned_to_date);
  acc.actual = acc.actual.add(e.actual);
  acc.billable = acc.billable.add(e.billable);
  acc.next = acc.next.map((v, i) => v.add(e.next[i]));
}

export type ForecastMonthPlan = {
  month: string;
  planned_hours: number;
  projected_actual_hours: number | null;
};

export type ForecastRow = {
  key: string;
  n_employees: number;
  planned_hours: number;
  planned_to_date_hours: number;
  actual_hours: number;
  actual_billable_hours: number;
  realization_pct: number | null;
  assumed_full_hours: number | null;
  next: ForecastMonthPlan[];
};

export type ForecastConsultantRow = ForecastRow & {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
};

function summarize(key: string, acc: Acc, nextMonths: string[]): ForecastRow {
  const ratio = realizationRatio(acc.actual, acc.planned_to_date);
  const assumed = projectAssumed(acc.planned_full, ratio);
  return {
    key,
    n_employees: acc.n,
    planned_hours: hrs(acc.planned_full),
    planned_to_date_hours: hrs(acc.planned_to_date),
    actual_hours: hrs(acc.actual),
    actual_billable_hours: hrs(acc.billable),
    realization_pct: ratio === null ? null : Number(ratio.mul(100).toFixed(1)),
    assumed_full_hours: assumed === null ? null : hrs(assumed),
    next: acc.next.map((planned, i) => {
      const proj = projectAssumed(planned, ratio);
      return {
        month: nextMonths[i],
        planned_hours: hrs(planned),
        projected_actual_hours: proj === null ? null : hrs(proj),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Capacity breakdown (per team, per month)
// ---------------------------------------------------------------------------

type CapAcc = {
  allocation: Decimal; // on-project (planned assignment allocation, raw)
  vacation: Decimal;
  intercontract: Decimal; // bench = max(0, available − allocation)
  overbook: Decimal; // planned beyond available
  available: Decimal; // capacity − vacation
  capacity: Decimal; // total paid capacity (the 100% base)
};

function newCapMonths(n: number): CapAcc[] {
  return Array.from({ length: n }, () => ({
    allocation: D0,
    vacation: D0,
    intercontract: D0,
    overbook: D0,
    available: D0,
    capacity: D0,
  }));
}

function addCap(accs: CapAcc[], i: number, b: CapAcc): void {
  accs[i] = {
    allocation: accs[i].allocation.add(b.allocation),
    vacation: accs[i].vacation.add(b.vacation),
    intercontract: accs[i].intercontract.add(b.intercontract),
    overbook: accs[i].overbook.add(b.overbook),
    available: accs[i].available.add(b.available),
    capacity: accs[i].capacity.add(b.capacity),
  };
}

// On-project + intercontract + vacation = capacity (the 100% base) when not
// overbooked; the total exceeds capacity by overbook when it is. All figures
// are hours; the client renders % of `capacity_h`.
export type CapacityBucket = {
  allocation_h: number; // on-project (planned assignment allocation)
  vacation_h: number;
  intercontract_h: number; // bench
  overbook_h: number; // planned beyond available (the overshoot past 100%)
  available_h: number; // capacity − vacation
  capacity_h: number; // total paid capacity (the 100% base)
};

export type CapacityTeamRow = {
  key: string; // "__total__" | team name
  months: CapacityBucket[];
};

export type CapacityBreakdown = {
  /** One per forecast month; `working_days` is the full-time FTE denominator
   * (client: hours ÷ (working_days × 8) = FTE). */
  months: { month: string; working_days: number }[];
  totals: CapacityTeamRow;
  by_team: CapacityTeamRow[];
};

function summarizeCap(key: string, accs: CapAcc[]): CapacityTeamRow {
  return {
    key,
    months: accs.map((a) => ({
      allocation_h: hrs(a.allocation),
      vacation_h: hrs(a.vacation),
      intercontract_h: hrs(a.intercontract),
      overbook_h: hrs(a.overbook),
      available_h: hrs(a.available),
      capacity_h: hrs(a.capacity),
    })),
  };
}

export type ForecastReport = {
  generated_for: string; // YYYY-MM-DD
  current_month: string; // YYYY-MM
  next_months: string[];
  totals: ForecastRow;
  by_team: ForecastRow[];
  by_role_tier: ForecastRow[];
  by_consultant: ForecastConsultantRow[];
  capacity: CapacityBreakdown;
};

/** Compute the whole forecast report as of `todayIso` (YYYY-MM-DD). */
export async function computeForecast(todayIso: string): Promise<ForecastReport> {
  const currentStart = firstOfMonth(todayIso);
  const windows: MonthWindow[] = [
    monthWindow(currentStart),
    ...Array.from({ length: FUTURE_MONTHS }, (_, i) =>
      monthWindow(addMonths(currentStart, i + 1)),
    ),
  ];
  const cur = windows[0];
  const nextMonthLabels = windows.slice(1).map((w) => w.month);

  // Current-month "to date" window: month start → today (clamped in-month).
  const toDateEnd = todayIso < cur.end ? todayIso : cur.end;
  const wdToDate = workingDaysInRange(cur.start, toDateEnd, cur.holidays);

  const employees = await listForecastEligible(
    cur.start,
    windows[windows.length - 1].end,
  );

  // Actual tracked hours (all buckets + billable) for the elapsed window.
  const tracked = await getTrackedHoursForMonth({
    month_start: cur.start,
    month_end: toDateEnd,
    team: null,
  });
  const trackedByEmp = new Map<number, { actual: Decimal; billable: Decimal }>();
  for (const t of tracked) {
    trackedByEmp.set(t.employee_id, {
      actual: new Decimal(t.b_min + t.nb_min + t.n_min).div(60),
      billable: new Decimal(t.b_min).div(60),
    });
  }

  const totals = newAcc();
  const teamMap = new Map<string, Acc>();
  const tierMap = new Map<string, Acc>();
  const consultants: ForecastConsultantRow[] = [];

  const capTotals = newCapMonths(windows.length);
  const capTeamMap = new Map<string, CapAcc[]>();

  for (const emp of employees) {
    // Employee's ACTUAL daily hours — capacity/vacation basis.
    const empDailyHours = new Decimal(emp.weekly_working_hours ?? 40).div(5);

    // Full-month planned allocation (hours) for every forecast month.
    // Allocation is a fraction of full-time, so hours use the full-time day.
    const plannedByMonth: Decimal[] = [];
    for (const w of windows) {
      const alloc = await employeeWeightedAllocInMonth(
        emp.employee_id,
        w.start,
        w.end,
        w.wd,
      );
      plannedByMonth.push(plannedHours(alloc, FULL_TIME_DAILY, w.wd.length));
    }

    // Current-month planned to-date (for the realization ratio).
    const allocToDate =
      wdToDate.length === 0
        ? D0
        : await employeeWeightedAllocInMonth(
            emp.employee_id,
            cur.start,
            toDateEnd,
            wdToDate,
          );
    const t = trackedByEmp.get(emp.employee_id) ?? { actual: D0, billable: D0 };

    const e: EmployeeForecast = {
      planned_full: plannedByMonth[0],
      planned_to_date: plannedHours(allocToDate, FULL_TIME_DAILY, wdToDate.length),
      actual: t.actual,
      billable: t.billable,
      next: plannedByMonth.slice(1),
    };

    addToAcc(totals, e);
    const teamKey = emp.team ?? "(no team)";
    const tAcc = teamMap.get(teamKey) ?? newAcc();
    addToAcc(tAcc, e);
    teamMap.set(teamKey, tAcc);
    const tierKey = emp.role_tier ?? "(unset)";
    const rAcc = tierMap.get(tierKey) ?? newAcc();
    addToAcc(rAcc, e);
    tierMap.set(tierKey, rAcc);

    const single = newAcc();
    addToAcc(single, e);
    const who = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || "—";
    consultants.push({
      ...summarize(who, single, nextMonthLabels),
      employee_id: emp.employee_id,
      who_name: who,
      team: emp.team,
      role_tier: emp.role_tier,
    });

    // Capacity breakdown per month for this employee.
    const empCap = capTeamMap.get(teamKey) ?? newCapMonths(windows.length);
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      // Contract-clip the month's working days to [hire, employment_end].
      const clipStart =
        emp.hire_date && emp.hire_date > w.start ? emp.hire_date : w.start;
      const clipEnd =
        emp.employment_end_date && emp.employment_end_date < w.end
          ? emp.employment_end_date
          : w.end;
      const contractWd = w.wd.filter((d) => d >= clipStart && d <= clipEnd);

      const [allAbs, unpaid] = await absencesForEmployee(
        emp.employee_id,
        w.start,
        w.end,
        w.holidays,
      );
      let unpaidDays = 0;
      let paidVacDays = 0;
      for (const d of contractWd) {
        if (unpaid.has(d)) unpaidDays++;
        else if (allAbs.has(d)) paidVacDays++;
      }
      // Paid capacity excludes unpaid leave entirely (no payroll load).
      // Capacity/vacation use the employee's ACTUAL daily hours so a
      // part-timer's capacity matches their fully-booked allocation hours.
      const capacityDays = Math.max(contractWd.length - unpaidDays, 0);
      const capacity_h = empDailyHours.mul(capacityDays);
      const vacation_h = empDailyHours.mul(paidVacDays);
      const allocation_h = plannedByMonth[i];
      // Split total capacity into on-project (deliverable, capped at available)
      // + bench + vacation — which always sums to capacity (100%). Overbook is
      // allocation beyond FULL capacity (genuine over-allocation); planned
      // vacation never counts as overbooking.
      const available_h = capacity_h.sub(vacation_h);
      const { on_project, bench, overbook } = capacitySplit(
        capacity_h,
        vacation_h,
        allocation_h,
      );
      const bucket: CapAcc = {
        allocation: on_project,
        vacation: vacation_h,
        intercontract: bench,
        overbook,
        available: available_h.gt(0) ? available_h : D0,
        capacity: capacity_h,
      };
      addCap(capTotals, i, bucket);
      addCap(empCap, i, bucket);
    }
    capTeamMap.set(teamKey, empCap);
  }

  const by_team = Array.from(teamMap, ([k, g]) => summarize(k, g, nextMonthLabels)).sort(
    (a, b) => b.planned_hours - a.planned_hours,
  );
  const by_role_tier = Array.from(tierMap, ([k, g]) =>
    summarize(k, g, nextMonthLabels),
  ).sort((a, b) => b.planned_hours - a.planned_hours);
  consultants.sort(
    (a, b) => b.planned_hours - a.planned_hours || a.who_name.localeCompare(b.who_name),
  );

  const capByTeam = Array.from(capTeamMap, ([k, accs]) =>
    summarizeCap(k, accs),
  ).sort(
    (a, b) => (b.months[0]?.capacity_h ?? 0) - (a.months[0]?.capacity_h ?? 0),
  );

  return {
    generated_for: todayIso,
    current_month: cur.month,
    next_months: nextMonthLabels,
    totals: summarize("__total__", totals, nextMonthLabels),
    by_team,
    by_role_tier,
    by_consultant: consultants,
    capacity: {
      months: windows.map((w) => ({ month: w.month, working_days: w.wd.length })),
      totals: summarizeCap("__total__", capTotals),
      by_team: capByTeam,
    },
  };
}
