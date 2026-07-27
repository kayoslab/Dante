import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import {
  getAvailableHoursForEmployees,
  getTrackedHoursForMonth,
} from "./tracked-hours";
import {
  absencesForEmployee,
  burdenFactor,
  employeeAllocSplitInMonth,
  entityMonthlyCost,
  fmt,
  fteFromWeeklyHours,
  holidaysForYearOf,
  lastOfMonth,
  type MonthCalendar,
  monthCalendarByState,
  workingDaysInRange,
} from "../_monthly-helpers";
import { roleTierFromAlias } from "../_sql-fragments";

// ---------------------------------------------------------------------------
// Utilization report — engine + shaped reads
//
// Used by `/reports/utilization` (page) and its two backing routes:
//  - `/api/reports/utilization/monthly-series` — trailing 12 + 3 forecast
//    months of totals + per-team + per-role-tier aggregates (drives the
//    trend chart, KPI tiles, per-row sparklines).
//  - `/api/reports/utilization/month` — selected-month consultant lists
//    (benched + overbooked) and the forecast-drivers window.
//
// The engine is the same per-employee-per-month load computation the
// portfolio bench section uses; this file factors it out so the
// monthly series can fan across teams and role tiers without
// duplicating proration / absence rules.
// ---------------------------------------------------------------------------

const ONE = new Decimal(1);

type MonthContext = {
  monthYm: string;
  month_start: string;
  month_end: string;
  holidays: Map<string, string>;
  working_days: string[];
  n_wd: number;
  burden: number;
  /** Per-office state-aware calendar — the per-employee working-day basis.
   * The federal fields above remain only for month-global context. */
  calFor: (office: string | null) => MonthCalendar;
};

async function loadMonthContext(monthYm: string): Promise<MonthContext> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);
  const holidays = holidaysForYearOf(month_start);
  const working_days = workingDaysInRange(month_start, month_end, holidays);
  return {
    monthYm,
    month_start,
    month_end,
    holidays,
    working_days,
    n_wd: working_days.length,
    burden: await burdenFactor(),
    calFor: monthCalendarByState(month_start, month_end),
  };
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

/** Active, real, project-contributing employees whose contract overlaps
 * the month. Same eligibility as the bench query, plus `role_tier`
 * pulled from `employee_role_tier` so we can group by it. */
async function listEligibleEmployees(
  month_start: string,
  month_end: string,
): Promise<EligibleEmployee[]> {
  const roleTier = roleTierFromAlias("ec", "ann");
  const r = await db.execute(sql`
    SELECT ec.employee_id, ec.first_name, ec.last_name,
           ec.weekly_working_hours,
           ec.hire_date, ec.employment_end_date, ec.office,
           COALESCE(ann.team_user, ec.department) AS team,
           ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      -- Include onboarding (future-start) hires; the hire_date window below
      -- scopes them to months they've actually started. Personio flips
      -- onboarding -> active on the start date.
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
    office: (row.office as string | null) ?? null,
    team: (row.team as string | null) ?? null,
    role_tier: (row.role_tier as string | null) ?? null,
  }));
}

type EmployeeMonthlyLoad = {
  employee: EligibleEmployee;
  loaded_cost: Decimal;
  weighted_alloc: Decimal; // 0–N as a fraction of FULL-TIME (can exceed fte)
  fte: Decimal; // contracted FTE (weekly_working_hours / 40); "fully booked" target
  util_ratio: Decimal; // weighted_alloc / fte — 1.0 = fully booked, >1 = overbook
  unallocated_cost: Decimal; // 0 when fully booked / overbooked (clamped)
};

/** Per-employee load for a month: prorated loaded cost, weighted
 * allocation across all assignments, and unallocated EUR. Mirrors
 * `computeMonthlyBenchTotals` (which sums these per-employee numbers
 * for the rentability report) so totals stay in sync. */
async function computeEmployeeLoad(
  emp: EligibleEmployee,
  ctx: MonthContext,
): Promise<EmployeeMonthlyLoad | null> {
  const { monthly_cost } = await entityMonthlyCost(
    emp.employee_id,
    null,
    null,
    ctx.burden,
    ctx.month_start,
  );
  if (monthly_cost === null) return null;

  // State-aware calendar for THIS employee's office (NRW fallback; federal
  // when office is null) — same basis as available-hours everywhere else.
  const cal = ctx.calFor(emp.office);
  const wd = cal.working_days;
  const n_wd = wd.length;

  const clip_start =
    emp.hire_date !== null && emp.hire_date > ctx.month_start
      ? emp.hire_date
      : ctx.month_start;
  const clip_end =
    emp.employment_end_date !== null && emp.employment_end_date < ctx.month_end
      ? emp.employment_end_date
      : ctx.month_end;
  const contract_workdays =
    n_wd > 0
      ? wd.filter((d) => d >= clip_start && d <= clip_end).length
      : 0;
  if (contract_workdays === 0) return null;

  const contract_share =
    n_wd > 0 ? new Decimal(contract_workdays).div(n_wd) : ONE;
  let loaded_cost = monthly_cost.mul(contract_share);

  const [, unpaid_in_month] = await absencesForEmployee(
    emp.employee_id,
    ctx.month_start,
    ctx.month_end,
    cal.holidays,
  );
  let unpaid_in_contract = 0;
  for (const [d, w] of unpaid_in_month) {
    if (d >= clip_start && d <= clip_end) unpaid_in_contract += w;
  }
  if (unpaid_in_contract > 0 && contract_workdays > 0) {
    const paid_share = new Decimal(
      contract_workdays - unpaid_in_contract,
    ).div(contract_workdays);
    loaded_cost = loaded_cost.mul(paid_share);
  }

  // BILLABLE allocations only: booked capacity means booked on billable
  // work. An assignment on a non-billable/internal project (e.g. an awork
  // Planner booking on an internal project) does not count as booked —
  // that person is bench from a revenue point of view.
  const alloc_split = await employeeAllocSplitInMonth(
    emp.employee_id,
    ctx.month_start,
    ctx.month_end,
    wd,
  );
  const weighted_alloc = alloc_split.billable;
  // `allocation_pct` is a fraction of full-time (40h), so a fully-booked
  // part-timer's `weighted_alloc` equals their FTE. Measure utilization
  // against FTE, not a hardcoded 1.0 — otherwise an 88%-contract employee
  // reads as 12% benched while fully allocated to their contract.
  const fte = fteFromWeeklyHours(emp.weekly_working_hours);
  const util_ratio = weighted_alloc.div(fte);
  const util_clamped = Decimal.min(util_ratio, ONE);
  let unallocated_cost = loaded_cost.mul(ONE.sub(util_clamped));
  if (unallocated_cost.lt(0)) unallocated_cost = new Decimal(0);

  return {
    employee: emp,
    loaded_cost,
    weighted_alloc,
    fte,
    util_ratio,
    unallocated_cost,
  };
}

// ---------------------------------------------------------------------------
// Public API: monthly aggregates (totals + per-team + per-role-tier)
// ---------------------------------------------------------------------------

export type UtilizationGroupAggregate = {
  key: string; // team name or role tier name
  n_employees: number;
  loaded_cost: string;
  unallocated_cost: string;
  util_pct_eur: string | null; // 0-100; null when loaded_cost is 0
  util_pct_headcount: string | null; // 0-100; null when n_employees is 0
};

export type UtilizationMonthAggregates = {
  month: string;
  is_forecast: boolean;
  totals: {
    n_employees: number;
    loaded_cost: string;
    unallocated_cost: string;
    util_pct_eur: string | null;
    util_pct_headcount: string | null;
    n_overbook: number;
  };
  by_team: UtilizationGroupAggregate[];
  by_role_tier: UtilizationGroupAggregate[];
};

type GroupAccumulator = {
  n: number;
  loaded: Decimal;
  unalloc: Decimal;
  util_sum: Decimal; // Σ min(weighted_alloc, 1) for headcount-weighted
};

function newGroupAcc(): GroupAccumulator {
  return {
    n: 0,
    loaded: new Decimal(0),
    unalloc: new Decimal(0),
    util_sum: new Decimal(0),
  };
}

function addToGroup(g: GroupAccumulator, load: EmployeeMonthlyLoad): void {
  g.n += 1;
  g.loaded = g.loaded.add(load.loaded_cost);
  g.unalloc = g.unalloc.add(load.unallocated_cost);
  g.util_sum = g.util_sum.add(Decimal.min(load.util_ratio, ONE));
}

function summarizeGroup(key: string, g: GroupAccumulator): UtilizationGroupAggregate {
  const util_pct_eur = g.loaded.gt(0)
    ? ONE.sub(g.unalloc.div(g.loaded)).mul(100)
    : null;
  const util_pct_headcount = g.n > 0 ? g.util_sum.div(g.n).mul(100) : null;
  return {
    key,
    n_employees: g.n,
    loaded_cost: fmt(g.loaded, 2),
    unallocated_cost: fmt(g.unalloc, 2),
    util_pct_eur: util_pct_eur === null ? null : fmt(util_pct_eur, 2),
    util_pct_headcount:
      util_pct_headcount === null ? null : fmt(util_pct_headcount, 2),
  };
}

/** Compute totals + per-team + per-role-tier aggregates for a single
 * month. Iterates every eligible employee once, then groups twice
 * (one pass for team, one pass for role tier). */
export async function computeUtilizationForMonth(
  monthYm: string,
  todayIso: string,
): Promise<UtilizationMonthAggregates> {
  const ctx = await loadMonthContext(monthYm);
  const employees = await listEligibleEmployees(ctx.month_start, ctx.month_end);

  const loads: EmployeeMonthlyLoad[] = [];
  for (const emp of employees) {
    const load = await computeEmployeeLoad(emp, ctx);
    if (load !== null) loads.push(load);
  }

  const totalsAcc = newGroupAcc();
  const teamMap = new Map<string, GroupAccumulator>();
  const tierMap = new Map<string, GroupAccumulator>();
  let n_overbook = 0;

  for (const load of loads) {
    addToGroup(totalsAcc, load);
    if (load.util_ratio.gt(ONE)) n_overbook++;

    const teamKey = load.employee.team ?? "(no team)";
    const t = teamMap.get(teamKey) ?? newGroupAcc();
    addToGroup(t, load);
    teamMap.set(teamKey, t);

    const tierKey = load.employee.role_tier ?? "(unset)";
    const r = tierMap.get(tierKey) ?? newGroupAcc();
    addToGroup(r, load);
    tierMap.set(tierKey, r);
  }

  const totalsSummary = summarizeGroup("__total__", totalsAcc);
  const by_team = Array.from(teamMap, ([k, g]) => summarizeGroup(k, g)).sort(
    (a, b) =>
      Number(b.unallocated_cost) - Number(a.unallocated_cost),
  );
  const by_role_tier = Array.from(tierMap, ([k, g]) =>
    summarizeGroup(k, g),
  ).sort((a, b) => Number(b.unallocated_cost) - Number(a.unallocated_cost));

  const month_start = `${monthYm}-01`;
  const is_forecast = month_start > todayIso;

  return {
    month: monthYm,
    is_forecast,
    totals: {
      n_employees: totalsSummary.n_employees,
      loaded_cost: totalsSummary.loaded_cost,
      unallocated_cost: totalsSummary.unallocated_cost,
      util_pct_eur: totalsSummary.util_pct_eur,
      util_pct_headcount: totalsSummary.util_pct_headcount,
      n_overbook,
    },
    by_team,
    by_role_tier,
  };
}

// ---------------------------------------------------------------------------
// Public API: realized billable utilization for a single month
// ---------------------------------------------------------------------------

/** Tracked-side sibling of the booked aggregates: billable TRACKED hours ÷
 * available hours (contract − absences, office-state holidays). This is what
 * actually happened, vs. Booked % which is what was committed. */
export type BillableUtilGroup = {
  key: string; // "__total__" | team | role tier
  available_h: number;
  billable_h: number;
  /** billable ÷ available × 100, 1 dp; null when no available hours. */
  billable_util_pct: number | null;
  /** Σ loaded cost of the group's employees (same proration as Bench cost). */
  loaded_cost: string;
  /** Realized bench cost: Σ loaded_cost × (1 − min(billable ÷ available, 1))
   * per employee — the cost of capacity that actually produced no billable
   * output. Retrospective sibling of the booking-based Bench cost. */
  realized_bench_cost: string;
};

export type RealizedBillableUtil = {
  totals: BillableUtilGroup;
  by_team: BillableUtilGroup[];
  by_role_tier: BillableUtilGroup[];
};

export async function computeRealizedBillableUtilForMonth(
  monthYm: string,
): Promise<RealizedBillableUtil> {
  const ctx = await loadMonthContext(monthYm);
  const employees = await listEligibleEmployees(ctx.month_start, ctx.month_end);
  const available = await getAvailableHoursForEmployees(
    employees.map((e) => e.employee_id),
    ctx.month_start,
    ctx.month_end,
  );
  const tracked = await getTrackedHoursForMonth({
    month_start: ctx.month_start,
    month_end: ctx.month_end,
    team: null,
  });
  const billableByEmp = new Map(
    tracked.map((t) => [t.employee_id, t.b_min / 60]),
  );

  type Acc = { a: number; b: number; loaded: Decimal; rbench: Decimal };
  const mk = (): Acc => ({
    a: 0,
    b: 0,
    loaded: new Decimal(0),
    rbench: new Decimal(0),
  });
  const totals = mk();
  const teamMap = new Map<string, Acc>();
  const tierMap = new Map<string, Acc>();
  for (const emp of employees) {
    const a = available.get(emp.employee_id) ?? 0;
    const b = billableByEmp.get(emp.employee_id) ?? 0;
    // Same prorated loaded cost the booking-based Bench cost uses, so the
    // two EUR figures differ only in their utilization basis. Employees
    // without a salary on file contribute hours but no cost — matching the
    // booked side, which skips them entirely.
    const load = await computeEmployeeLoad(emp, ctx);
    let loaded = new Decimal(0);
    let rbench = new Decimal(0);
    if (load !== null) {
      loaded = load.loaded_cost;
      const realizedShare = a > 0 ? Math.min(b / a, 1) : 0;
      rbench = loaded.mul(1 - realizedShare);
    }
    const fold = (acc: Acc) => {
      acc.a += a;
      acc.b += b;
      acc.loaded = acc.loaded.add(loaded);
      acc.rbench = acc.rbench.add(rbench);
    };
    fold(totals);
    const teamKey = emp.team ?? "(no team)";
    const t = teamMap.get(teamKey) ?? mk();
    fold(t);
    teamMap.set(teamKey, t);
    const tierKey = emp.role_tier ?? "(unset)";
    const r = tierMap.get(tierKey) ?? mk();
    fold(r);
    tierMap.set(tierKey, r);
  }
  const toGroup = (key: string, acc: Acc): BillableUtilGroup => ({
    key,
    available_h: Number(acc.a.toFixed(1)),
    billable_h: Number(acc.b.toFixed(1)),
    billable_util_pct:
      acc.a > 0 ? Number(((acc.b / acc.a) * 100).toFixed(1)) : null,
    loaded_cost: fmt(acc.loaded, 2),
    realized_bench_cost: fmt(acc.rbench, 2),
  });
  return {
    totals: toGroup("__total__", totals),
    by_team: Array.from(teamMap, ([k, g]) => toGroup(k, g)),
    by_role_tier: Array.from(tierMap, ([k, g]) => toGroup(k, g)),
  };
}

// ---------------------------------------------------------------------------
// Public API: selected-month consultant lists (benched + overbooked)
// ---------------------------------------------------------------------------

export type BenchedConsultant = {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
  loaded_cost: string;
  utilization_pct: string; // 0–N, can exceed 1 in theory but bench list is util < 1
  unallocated_cost: string;
  bench_since_date: string | null;
  bench_since_days: number | null;
};

export type OverbookedConsultant = {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
  loaded_cost: string;
  utilization_pct: string;
  overbook_pct: string; // (util - 1) * 100
};

/** Most recent end_date for an assignment that ended *before* `today`.
 * Used to compute "bench since N days". Returns null if the employee
 * has never been assigned (new hire). */
async function lastAssignmentEndBefore(
  employee_id: number,
  today: string,
): Promise<string | null> {
  const r = await db.execute(sql`
    SELECT MAX(end_date) AS last_end
    FROM assignment
    WHERE employee_id = ${employee_id}
      AND end_date IS NOT NULL
      AND end_date < ${today}::date
  `);
  const row = (r.rows as Array<{ last_end: string | null }>)[0];
  return row?.last_end ?? null;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export type UtilizationMonthDetail = {
  benched: BenchedConsultant[];
  overbooked: OverbookedConsultant[];
};

export async function listUtilizationConsultantsForMonth(
  monthYm: string,
  todayIso: string,
): Promise<UtilizationMonthDetail> {
  const ctx = await loadMonthContext(monthYm);
  const employees = await listEligibleEmployees(ctx.month_start, ctx.month_end);

  const benched: BenchedConsultant[] = [];
  const overbooked: OverbookedConsultant[] = [];

  for (const emp of employees) {
    const load = await computeEmployeeLoad(emp, ctx);
    if (load === null) continue;

    const who_name = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim();
    // Utilization is measured against the employee's FTE (see
    // `computeEmployeeLoad`): fully booked = 1.0, overbooked > 1.0.
    if (load.util_ratio.gt(ONE)) {
      overbooked.push({
        employee_id: emp.employee_id,
        who_name,
        team: emp.team,
        role_tier: emp.role_tier,
        loaded_cost: fmt(load.loaded_cost, 2),
        utilization_pct: fmt(load.util_ratio, 4),
        overbook_pct: fmt(load.util_ratio.sub(ONE).mul(100), 2),
      });
    } else if (load.util_ratio.lt(ONE)) {
      // Bench-since only makes sense for FULL bench. Partial bench
      // (0 < util < 1) means they're allocated to something now;
      // surfacing a "since" date there is misleading.
      let bench_since_date: string | null = null;
      let bench_since_days: number | null = null;
      if (load.weighted_alloc.eq(0)) {
        bench_since_date = await lastAssignmentEndBefore(
          emp.employee_id,
          todayIso,
        );
        if (bench_since_date !== null) {
          bench_since_days = daysBetween(bench_since_date, todayIso);
        } else if (emp.hire_date !== null) {
          bench_since_date = emp.hire_date;
          bench_since_days = daysBetween(emp.hire_date, todayIso);
        }
      }
      benched.push({
        employee_id: emp.employee_id,
        who_name,
        team: emp.team,
        role_tier: emp.role_tier,
        loaded_cost: fmt(load.loaded_cost, 2),
        utilization_pct: fmt(load.util_ratio, 4),
        unallocated_cost: fmt(load.unallocated_cost, 2),
        bench_since_date,
        bench_since_days,
      });
    }
  }

  benched.sort((a, b) => Number(b.unallocated_cost) - Number(a.unallocated_cost));
  overbooked.sort((a, b) => Number(b.overbook_pct) - Number(a.overbook_pct));

  return { benched, overbooked };
}

// ---------------------------------------------------------------------------
// Public API: forecast-drivers window (projects ending + hires starting)
// ---------------------------------------------------------------------------

export type ProjectEndingInWindow = {
  project_id: number;
  project_name: string;
  customer_name: string;
  end_date: string;
  n_assignments: number;
  freeing_alloc_sum: string; // sum of allocation_pct across ending assignments
};

export type HireStartingInWindow = {
  employee_id: number;
  who_name: string;
  hire_date: string;
  team: string | null;
  role_tier: string | null;
};

export type ForecastDrivers = {
  from_date: string;
  to_date: string;
  projects_ending: ProjectEndingInWindow[];
  hires_starting: HireStartingInWindow[];
};

/** "Why is the forecast curve doing that?" — the two main drivers of
 * future utilization swings. Projects-ending frees consultants; new
 * hires add loaded payroll. Both are surfaced in the same window. */
export async function listForecastDrivers(
  from_date: string,
  to_date: string,
): Promise<ForecastDrivers> {
  // Projects ending: aggregate assignments whose end_date lands in the
  // window. One row per (project, end_date) — if a project has multiple
  // assignments ending the same day, the row sums the allocations
  // freeing up.
  const endingRes = await db.execute(sql`
    SELECT a.project_id,
           p.name AS project_name,
           c.name AS customer_name,
           a.end_date,
           COUNT(*)::int AS n_assignments,
           SUM(a.allocation_pct)::text AS freeing_alloc_sum
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    JOIN employee_current ec ON ec.employee_id = a.employee_id
    JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE a.end_date IS NOT NULL
      AND a.end_date BETWEEN ${from_date}::date AND ${to_date}::date
      AND COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
    GROUP BY a.project_id, p.name, c.name, a.end_date
    ORDER BY a.end_date, p.name
  `);
  const projects_ending = (endingRes.rows as Array<Record<string, unknown>>).map(
    (row) => ({
      project_id: row.project_id as number,
      project_name: row.project_name as string,
      customer_name: row.customer_name as string,
      end_date: row.end_date as string,
      n_assignments: row.n_assignments as number,
      freeing_alloc_sum: String(row.freeing_alloc_sum ?? "0"),
    }),
  );

  // Hires starting in window: real, project-contributing, active.
  const roleTier = roleTierFromAlias("ec", "ann");
  const hiresRes = await db.execute(sql`
    SELECT ec.employee_id,
           ec.first_name, ec.last_name,
           ec.hire_date,
           COALESCE(ann.team_user, ec.department) AS team,
           ${roleTier} AS role_tier
    FROM employee_current ec
    LEFT JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE ec.hire_date IS NOT NULL
      AND ec.hire_date BETWEEN ${from_date}::date AND ${to_date}::date
      AND COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      -- Future hires are 'onboarding' in Personio until their start date;
      -- this "hires starting" driver must include them (that is its whole
      -- point) -- active-only would list nobody actually joining.
      AND ec.status IN ('active', 'onboarding')
    ORDER BY ec.hire_date, ec.last_name
  `);
  const hires_starting = (hiresRes.rows as Array<Record<string, unknown>>).map(
    (row) => {
      const first = (row.first_name as string | null) ?? null;
      const last = (row.last_name as string | null) ?? null;
      return {
        employee_id: row.employee_id as number,
        who_name: `${first ?? ""} ${last ?? ""}`.trim(),
        hire_date: row.hire_date as string,
        team: (row.team as string | null) ?? null,
        role_tier: (row.role_tier as string | null) ?? null,
      };
    },
  );

  return { from_date, to_date, projects_ending, hires_starting };
}
