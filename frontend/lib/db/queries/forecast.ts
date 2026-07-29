import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  addMonths,
  allocDaySumsForEmployees,
  firstOfMonth,
  holidaysForYearOf,
  lastOfMonth,
  monthDayStatsForEmployees,
  workingDaysInRange,
} from "../_monthly-helpers";
import {
  addToCapacityAcc,
  capacityBuckets,
  newCapacityAcc,
  ratioOrNull,
  type CapacityAcc,
  type CapacityContribution,
} from "../_capacity-model";
import { roleTierFromAlias } from "../_sql-fragments";
import { getTrackedHoursForMonth } from "./tracked-hours";

// ---------------------------------------------------------------------------
// Forecast report — engine + shaped read. Manager-only, backs /reports/forecast.
//
// The WHOLE report is computed from ONE per-(employee, month) capacity model
// (`_capacity-model.ts`), so every section tells one consistent story:
//
//  - Performed vs planned (per team / role / consultant): compares planned
//    BILLABLE hours to actual BILLABLE hours against available capacity. It no
//    longer uses total tracked (billable + internal + untagged) as "actual" —
//    that inflated realization whenever someone booked unplanned internal time.
//    Headline KPI = billable utilization (actual billable ÷ available).
//
//  - Capacity breakdown (per team, per month): the same buckets, so available
//    capacity resolves into billable delivered + allocated-not-billed + bench,
//    with paid vacation shown outside and over-allocation flagged. Future
//    months (no bookings yet) reduce to the planned view.
//
// Bench = UNUSED capacity: driven by the plan, reduced by actual billable work,
// never created by under-delivering an allocation. See `_capacity-model.ts`.
// ---------------------------------------------------------------------------

const D0 = new Decimal(0);
const FUTURE_MONTHS = 2;
/** A full-time day. `allocation_pct` is a fraction of full-time (the awork sync
 * divides planned hours by an 8h day), so planned HOURS = allocation × 8 ×
 * working-days, independent of the employee's own daily hours. Capacity /
 * vacation use the employee's ACTUAL daily hours (weekly_working_hours ÷ 5). */
const FULL_TIME_DAILY = new Decimal(8);

/** hours as a plain number, 2 dp (display formats to 1). */
function hrs(d: Decimal): number {
  return Number(d.toFixed(2));
}
/** ratio → percent (1 dp) or null. */
function pct(r: Decimal | null): number | null {
  return r === null ? null : Number(r.mul(100).toFixed(1));
}

type EligibleEmployee = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  weekly_working_hours: number | null;
  hire_date: string | null;
  employment_end_date: string | null;
  office: string | null;
  team: string | null;
  role_tier: string | null;
};

/** Active, real, project-contributing employees whose contract overlaps the
 * forecast window. Same eligibility as the utilization engine. */
async function listForecastEligible(
  window_start: string,
  window_end: string,
): Promise<EligibleEmployee[]> {
  const roleTier = roleTierFromAlias("ec", "ann");
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.weekly_working_hours, ec.hire_date, ec.employment_end_date,
           ec.office,
           COALESCE(ann.team_user, ec.department) AS team,
           ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status IN ('active', 'onboarding')
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${window_end}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${window_start}::date)
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    employee_id: row.employee_id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    weekly_working_hours:
      row.weekly_working_hours === null ||
      row.weekly_working_hours === undefined
        ? null
        : Number(row.weekly_working_hours),
    hire_date: (row.hire_date as string | null) ?? null,
    employment_end_date: (row.employment_end_date as string | null) ?? null,
    office: (row.office as string | null) ?? null,
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
  return {
    month: monthStart.slice(0, 7),
    start: monthStart,
    end,
    wd,
    holidays,
  };
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Planned billable / available for a future month (forward view). */
export type ForecastMonthPlan = {
  month: string;
  planned_billable_h: number;
  available_h: number;
};

/** A performed-vs-planned rollup row (per total / team / role / consultant),
 * current-month figures + a forward plan. Hours are current-month; where the
 * month is still running, actuals are month-to-date. */
export type ForecastRow = {
  key: string;
  n_employees: number;
  capacity_h: number;
  available_h: number;
  vacation_h: number;
  planned_billable_h: number;
  actual_billable_h: number;
  actual_nonbillable_h: number;
  bench_h: number;
  over_h: number;
  /** actual billable ÷ available — the headline utilization (month-to-date). */
  utilization_pct: number | null;
  /** bench ÷ available — share of capacity with no work. */
  bench_pct: number | null;
  /** actual billable ÷ planned billable to-date — delivery against plan. */
  delivery_pct: number | null;
  next: ForecastMonthPlan[];
};

export type ForecastConsultantRow = ForecastRow & {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
};

/** Per-month partition of a team's paid capacity. `billable_delivered +
 * allocated_not_billed + bench + vacation = capacity` (over-allocation shown
 * separately). Future months have no bookings → billable_delivered 0 and the
 * split is the planned view. */
export type CapacityBucket = {
  capacity_h: number;
  available_h: number;
  vacation_h: number;
  /** Engaged (on-project) capacity. Non-billable is never planned, so this is
   * effectively the billable allocation; any rare planned-internal allocation
   * is folded in here rather than shown as its own (near-always-empty) column. */
  on_project_h: number;
  bench_h: number;
  over_h: number;
};

export type CapacityTeamRow = {
  key: string; // "__total__" | team name
  months: CapacityBucket[];
};

export type CapacityBreakdown = {
  months: { month: string; working_days: number }[];
  totals: CapacityTeamRow;
  by_team: CapacityTeamRow[];
};

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

// ---------------------------------------------------------------------------
// Shaping (accumulator → wire)
// ---------------------------------------------------------------------------

/** Current-month KPIs from that rollup's per-month accumulators. `accs[0]` is
 * the current month; the rest are the forward plan. */
function toForecastRow(
  key: string,
  accs: CapacityAcc[],
  months: string[],
): ForecastRow {
  const cur = accs[0];
  return {
    key,
    n_employees: cur.n,
    capacity_h: hrs(cur.capacity),
    available_h: hrs(cur.available),
    vacation_h: hrs(cur.vacation),
    planned_billable_h: hrs(cur.planned_billable),
    actual_billable_h: hrs(cur.actual_billable),
    actual_nonbillable_h: hrs(cur.actual_nonbillable),
    bench_h: hrs(cur.bench),
    over_h: hrs(cur.over),
    // Denominator is available-to-date so the KPI is trend-comparable on any
    // day of the month (both sides month-to-date).
    utilization_pct: pct(
      ratioOrNull(cur.actual_billable, cur.available_to_date),
    ),
    bench_pct: pct(ratioOrNull(cur.bench, cur.available)),
    delivery_pct: pct(
      ratioOrNull(cur.actual_billable, cur.planned_billable_to_date),
    ),
    next: accs.slice(1).map((a, i) => ({
      month: months[i + 1],
      planned_billable_h: hrs(a.planned_billable),
      available_h: hrs(a.available),
    })),
  };
}

function toCapacityBucket(a: CapacityAcc): CapacityBucket {
  return {
    capacity_h: hrs(a.capacity),
    available_h: hrs(a.available),
    vacation_h: hrs(a.vacation),
    on_project_h: hrs(a.on_project_billable.add(a.on_project_nonbillable)),
    bench_h: hrs(a.bench),
    over_h: hrs(a.over),
  };
}

/** A rollup bucket = one CapacityAcc per forecast month. */
function newMonthAccs(n: number): CapacityAcc[] {
  return Array.from({ length: n }, () => newCapacityAcc());
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export async function computeForecast(
  todayIso: string,
): Promise<ForecastReport> {
  const currentStart = firstOfMonth(todayIso);
  const windows: MonthWindow[] = [
    monthWindow(currentStart),
    ...Array.from({ length: FUTURE_MONTHS }, (_, i) =>
      monthWindow(addMonths(currentStart, i + 1)),
    ),
  ];
  const cur = windows[0];
  const monthLabels = windows.map((w) => w.month);

  // Current-month "to date" window: month start → today (clamped in-month).
  const toDateEnd = todayIso < cur.end ? todayIso : cur.end;

  // NB: the window's own `wd` (federal) remains only as the display
  // denominator (months[].working_days → client FTE conversion); the
  // per-employee capacity math is state-aware via the bulk stats below.
  const employees = await listForecastEligible(
    cur.start,
    windows[windows.length - 1].end,
  );

  // Actual tracked hours (billable vs non-billable/untagged), month-to-date.
  const tracked = await getTrackedHoursForMonth({
    month_start: cur.start,
    month_end: toDateEnd,
    team: null,
  });
  const trackedByEmp = new Map<
    number,
    { billable: Decimal; nonbillable: Decimal }
  >();
  for (const t of tracked) {
    trackedByEmp.set(t.employee_id, {
      billable: new Decimal(t.b_min).div(60),
      nonbillable: new Decimal(t.nb_min + t.n_min).div(60),
    });
  }

  const nMonths = windows.length;
  const totals = newMonthAccs(nMonths);
  const teamMap = new Map<string, CapacityAcc[]>();
  const tierMap = new Map<string, CapacityAcc[]>();
  const consultants: ForecastConsultantRow[] = [];

  // All calendar/absence/allocation inputs come from per-month SET queries
  // on state_holiday / absence_day (two per forecast month, covering the
  // whole roster) — the per-employee math below is pure and synchronous.
  // State-awareness (office → state, NRW fallback, federal for null office)
  // and contract clipping live inside the bulk helpers.
  const empIds = employees.map((e) => e.employee_id);
  const statsByMonth = await Promise.all(
    windows.map((w, i) =>
      Promise.all([
        monthDayStatsForEmployees(
          empIds,
          w.start,
          w.end,
          i === 0 ? toDateEnd : undefined,
        ),
        allocDaySumsForEmployees(
          empIds,
          w.start,
          w.end,
          i === 0 ? toDateEnd : undefined,
        ),
      ]),
    ),
  );

  const perEmployee = employees.map((emp) => {
    const empDailyHours = new Decimal(emp.weekly_working_hours ?? 40).div(5);
    const tr = trackedByEmp.get(emp.employee_id) ?? {
      billable: D0,
      nonbillable: D0,
    };
    const contributions: CapacityContribution[] = [];

    for (let i = 0; i < nMonths; i++) {
      const isCurrent = i === 0;
      const [dayStats, allocSums] = statsByMonth[i];
      const st = dayStats.get(emp.employee_id);
      const al = allocSums.get(emp.employee_id);

      // Weighted absence days: Personio half-days count 0.5. Paid-vacation
      // weight = all-absence minus the unpaid share of the same day — both
      // pre-aggregated over the contract-clipped state working days.
      const capacityDays = Math.max(
        (st?.contract_wd ?? 0) - (st?.unpaid_w ?? 0),
        0,
      );
      const capacity = empDailyHours.mul(capacityDays);
      const vacation = empDailyHours.mul(st?.paid_vac_w ?? 0);

      // Available capacity TO DATE (current month only): same construction
      // clipped to elapsed working days. This is the utilization denominator —
      // month-to-date billable over month-to-date available — so the KPI is
      // comparable on any day of the month instead of climbing from ~0%.
      let available_to_date: Decimal | null = null;
      if (isCurrent) {
        const availTdDays = Math.max(
          (st?.contract_wd_td ?? 0) -
            (st?.unpaid_w_td ?? 0) -
            (st?.paid_vac_w_td ?? 0),
          0,
        );
        available_to_date = empDailyHours.mul(availTdDays);
      }

      // Planned hours = Σ allocation_pct × active working day × 8h — the
      // same figure the old per-employee fraction × working-days × 8
      // produced, without the intermediate division.
      const planned_total = (al?.total ?? D0).mul(FULL_TIME_DAILY);
      const planned_billable = (al?.billable ?? D0).mul(FULL_TIME_DAILY);

      // Current month: month-to-date actuals + to-date planned (for delivery).
      let actual_billable = D0;
      let actual_nonbillable = D0;
      let planned_billable_to_date = D0;
      if (isCurrent) {
        actual_billable = tr.billable;
        actual_nonbillable = tr.nonbillable;
        planned_billable_to_date = (al?.billable_td ?? D0).mul(FULL_TIME_DAILY);
      }

      const buckets = capacityBuckets({
        capacity,
        vacation,
        planned_total,
        planned_billable,
        actual_billable,
      });
      const contribution: CapacityContribution = {
        capacity,
        vacation,
        planned_total,
        planned_billable,
        planned_billable_to_date,
        actual_billable,
        actual_nonbillable,
        // Future months have no "to date" concept — use full available so the
        // accumulator field is always meaningful.
        available_to_date: available_to_date ?? buckets.available,
        buckets,
      };
      contributions.push(contribution);
    }
    return contributions;
  });

  for (const [idx, emp] of employees.entries()) {
    const contributions = perEmployee[idx];
    const teamKey = emp.team ?? "(no team)";
    const tierKey = emp.role_tier ?? "(unset)";
    const teamAccs = teamMap.get(teamKey) ?? newMonthAccs(nMonths);
    const tierAccs = tierMap.get(tierKey) ?? newMonthAccs(nMonths);
    const empAccs = newMonthAccs(nMonths);

    for (let i = 0; i < nMonths; i++) {
      const contribution = contributions[i];
      addToCapacityAcc(totals[i], contribution);
      addToCapacityAcc(teamAccs[i], contribution);
      addToCapacityAcc(tierAccs[i], contribution);
      addToCapacityAcc(empAccs[i], contribution);
    }

    teamMap.set(teamKey, teamAccs);
    tierMap.set(tierKey, tierAccs);
    const who = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || "—";
    consultants.push({
      ...toForecastRow(who, empAccs, monthLabels),
      employee_id: emp.employee_id,
      who_name: who,
      team: emp.team,
      role_tier: emp.role_tier,
    });
  }

  const by_team = Array.from(teamMap, ([k, accs]) =>
    toForecastRow(k, accs, monthLabels),
  ).sort((a, b) => b.available_h - a.available_h);
  const by_role_tier = Array.from(tierMap, ([k, accs]) =>
    toForecastRow(k, accs, monthLabels),
  ).sort((a, b) => b.available_h - a.available_h);
  consultants.sort(
    (a, b) =>
      b.available_h - a.available_h || a.who_name.localeCompare(b.who_name),
  );

  const capByTeam: CapacityTeamRow[] = Array.from(teamMap, ([k, accs]) => ({
    key: k,
    months: accs.map(toCapacityBucket),
  })).sort(
    (a, b) => (b.months[0]?.capacity_h ?? 0) - (a.months[0]?.capacity_h ?? 0),
  );

  return {
    generated_for: todayIso,
    current_month: cur.month,
    next_months: monthLabels.slice(1),
    totals: toForecastRow("__total__", totals, monthLabels),
    by_team,
    by_role_tier,
    by_consultant: consultants,
    capacity: {
      months: windows.map((w) => ({
        month: w.month,
        working_days: w.wd.length,
      })),
      totals: { key: "__total__", months: totals.map(toCapacityBucket) },
      by_team: capByTeam,
    },
  };
}
