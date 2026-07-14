import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  addMonths,
  employeeWeightedAllocInMonth,
  firstOfMonth,
  holidaysForYearOf,
  lastOfMonth,
  workingDaysInRange,
} from "../_monthly-helpers";
import { roleTierFromAlias } from "../_sql-fragments";
import { getTrackedHoursForMonth } from "./tracked-hours";
import { plannedHours, projectAssumed, realizationRatio } from "./_forecast-math";

// ---------------------------------------------------------------------------
// Forecast report — engine + shaped read.
//
// Backs `/reports/forecast` (manager-only). Answers: are we delivering the
// plan this month, and what's the planned pipeline for the next two months?
//
//  - Planned allocation (a fraction of FTE, from `assignment`) is converted
//    to planned HOURS so it's comparable to actual tracked hours.
//  - Realization ratio = actual worked hours to-date ÷ planned hours to-date,
//    computed PER rollup level (org / team / role tier / consultant). Applied
//    to the full month → "assumed" full-month hours, and to the next two
//    months → "projected" actuals.
//
// Absences aren't modelled explicitly: the current-month ratio already
// absorbs them (time off → lower actual → lower ratio → lower assumed), and
// the future months intentionally show the raw plan.
// ---------------------------------------------------------------------------

const D0 = new Decimal(0);
const FUTURE_MONTHS = 2;

/** hours as a plain number, rounded to 2 dp (display formats to 1). */
function hrs(d: Decimal): number {
  return Number(d.toFixed(2));
}

type EligibleEmployee = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  weekly_working_hours: number | null;
  team: string | null;
  role_tier: string | null;
};

/** Active, real, project-contributing employees whose contract overlaps the
 * forecast window [current month start, +2 month end]. Same eligibility as
 * the utilization engine, plus `weekly_working_hours` (→ daily hours). */
async function listForecastEligible(
  window_start: string,
  window_end: string,
): Promise<EligibleEmployee[]> {
  const roleTier = roleTierFromAlias("ec", "ann");
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.weekly_working_hours,
           COALESCE(ann.team_user, ec.department) AS team,
           ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
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
    team: (row.team as string | null) ?? null,
    role_tier: (row.role_tier as string | null) ?? null,
  }));
}

type MonthWindow = { month: string; start: string; end: string; wd: string[] };

function monthWindow(monthStart: string): MonthWindow {
  const end = lastOfMonth(monthStart);
  const wd = workingDaysInRange(monthStart, end, holidaysForYearOf(monthStart));
  return { month: monthStart.slice(0, 7), start: monthStart, end, wd };
}

// ---------------------------------------------------------------------------
// Per-employee numbers, then rollup accumulators.
// ---------------------------------------------------------------------------

type EmployeeForecast = {
  planned_full: Decimal; // current month, full
  planned_to_date: Decimal; // current month, up to today
  actual: Decimal; // current month to date, all tracked
  billable: Decimal; // current month to date, billable only
  next: Decimal[]; // planned hours for each future month
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
  month: string; // YYYY-MM
  planned_hours: number;
  /** planned × current realization ratio; null when there's no ratio yet. */
  projected_actual_hours: number | null;
};

export type ForecastRow = {
  key: string; // "__total__" | team name | role tier name
  n_employees: number;
  // Current month
  planned_hours: number; // full month
  planned_to_date_hours: number;
  actual_hours: number; // all tracked, to date
  actual_billable_hours: number; // billable subset, to date
  realization_pct: number | null; // ratio × 100 (actual ÷ planned-to-date)
  assumed_full_hours: number | null; // planned_full × ratio
  // Upcoming
  next: ForecastMonthPlan[];
};

export type ForecastConsultantRow = ForecastRow & {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
};

export type ForecastReport = {
  generated_for: string; // today (YYYY-MM-DD)
  current_month: string; // YYYY-MM
  next_months: string[]; // [YYYY-MM, YYYY-MM]
  totals: ForecastRow;
  by_team: ForecastRow[];
  by_role_tier: ForecastRow[];
  by_consultant: ForecastConsultantRow[];
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
  const future = windows.slice(1);
  const nextMonthLabels = future.map((w) => w.month);

  // Current-month "to date" window: month start → today (clamped in-month).
  const toDateEnd = todayIso < cur.end ? todayIso : cur.end;
  const wdToDate = workingDaysInRange(
    cur.start,
    toDateEnd,
    holidaysForYearOf(cur.start),
  );

  const employees = await listForecastEligible(cur.start, windows[windows.length - 1].end);

  // Actual tracked hours (all buckets + billable) for the elapsed window,
  // keyed by employee. One query covers everyone.
  const tracked = await getTrackedHoursForMonth({
    month_start: cur.start,
    month_end: toDateEnd,
    team: null,
  });
  const trackedByEmp = new Map<number, { actual: Decimal; billable: Decimal }>();
  for (const t of tracked) {
    const total = new Decimal(t.b_min + t.u_min + t.n_min).div(60);
    const billable = new Decimal(t.b_min).div(60);
    trackedByEmp.set(t.employee_id, { actual: total, billable });
  }

  const totals = newAcc();
  const teamMap = new Map<string, Acc>();
  const tierMap = new Map<string, Acc>();
  const consultants: ForecastConsultantRow[] = [];

  for (const emp of employees) {
    const dailyHours = new Decimal(emp.weekly_working_hours ?? 40).div(5);

    const alloc_full = await employeeWeightedAllocInMonth(
      emp.employee_id,
      cur.start,
      cur.end,
      cur.wd,
    );
    const alloc_to_date =
      wdToDate.length === 0
        ? D0
        : await employeeWeightedAllocInMonth(
            emp.employee_id,
            cur.start,
            toDateEnd,
            wdToDate,
          );

    const t = trackedByEmp.get(emp.employee_id) ?? { actual: D0, billable: D0 };

    const next: Decimal[] = [];
    for (const w of future) {
      const a = await employeeWeightedAllocInMonth(
        emp.employee_id,
        w.start,
        w.end,
        w.wd,
      );
      next.push(plannedHours(a, dailyHours, w.wd.length));
    }

    const e: EmployeeForecast = {
      planned_full: plannedHours(alloc_full, dailyHours, cur.wd.length),
      planned_to_date: plannedHours(alloc_to_date, dailyHours, wdToDate.length),
      actual: t.actual,
      billable: t.billable,
      next,
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
  }

  const by_team = Array.from(teamMap, ([k, g]) => summarize(k, g, nextMonthLabels)).sort(
    (a, b) => b.planned_hours - a.planned_hours,
  );
  const by_role_tier = Array.from(tierMap, ([k, g]) =>
    summarize(k, g, nextMonthLabels),
  ).sort((a, b) => b.planned_hours - a.planned_hours);
  // Most-planned consultants first; ties broken by name for stable order.
  consultants.sort(
    (a, b) => b.planned_hours - a.planned_hours || a.who_name.localeCompare(b.who_name),
  );

  return {
    generated_for: todayIso,
    current_month: cur.month,
    next_months: nextMonthLabels,
    totals: summarize("__total__", totals, nextMonthLabels),
    by_team,
    by_role_tier,
    by_consultant: consultants,
  };
}
