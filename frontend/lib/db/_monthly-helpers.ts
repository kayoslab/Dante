/** Shared helpers for the monthly P&L endpoints (B.8.1+).
 *
 * Ports `src/dante/api/service/project_monthly/_helpers.py` to
 * TypeScript. The functions here are pure (modulo the `db` connection) and
 * mirror the Python implementation 1:1 — same arithmetic, same Decimal
 * precision, same SQL. Tests are the b8_parity snapshot harness in
 * scripts/b8_parity.py; keep behavior byte-identical until those pass.
 *
 * Why Decimal everywhere: Python `Decimal` keeps cent-level precision for
 * cost/revenue/margin. IEEE-754 floats would silently drift fractions of a
 * cent across the many Σ accumulations these functions do. `decimal.js`
 * matches Python `Decimal` semantics when configured with banker's rounding,
 * which is Python's default.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "./client";
import {
  germanFederalHolidays,
  germanHolidaysForStateCached,
  stateCodeForOffice,
} from "./_de-holidays";
import { resolveSalaryFromRow } from "./_salary-resolve";

export { resolveSalaryFromRow } from "./_salary-resolve";
export type { SalaryRow, ResolvedSalary } from "./_salary-resolve";

// Match Python Decimal defaults: 28-digit precision, ROUND_HALF_EVEN (banker's).
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export const WEEKS_PER_MONTH = new Decimal(52).div(12); // 4.3333...

// ----------------------------------------------------------------------------
// Date utilities
// ----------------------------------------------------------------------------

/** Returns a `YYYY-MM-DD` string for the first day of the given month. */
export function firstOfMonth(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function firstOfNextMonth(iso: string): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny.toString().padStart(4, "0")}-${nm
    .toString()
    .padStart(2, "0")}-01`;
}

export function lastOfMonth(iso: string): string {
  return shiftDay(firstOfNextMonth(iso), -1);
}

export function shiftDay(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, n: number): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny.toString().padStart(4, "0")}-${nm
    .toString()
    .padStart(2, "0")}-01`;
}

/** True if `a` ≤ `b` for YYYY-MM-DD strings (lexicographic == chronological). */
export function isoLte(a: string, b: string): boolean {
  return a <= b;
}

export function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

export function minIso(
  a: string | null | undefined,
  b: string,
): string {
  if (a === null || a === undefined) return b;
  return a < b ? a : b;
}

/** List of YYYY-MM-DD weekdays in [start, end] that are NOT public holidays. */
export function workingDaysInRange(
  start: string,
  end: string,
  holidays: Map<string, string>,
): string[] {
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (cur <= last) {
    const day = cur.getUTCDay(); // 0=Sun, 6=Sat
    const iso = cur.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(iso)) out.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Convenience: build the German federal holidays set for the year of `iso`. */
export function holidaysForYearOf(iso: string): Map<string, string> {
  const y = Number(iso.slice(0, 4));
  return germanFederalHolidays(y, y);
}

// ----------------------------------------------------------------------------
// Decimal helpers
// ----------------------------------------------------------------------------

/** Construct a Decimal from a value that might be a string/number/null. */
export function dec(v: unknown): Decimal {
  if (v === null || v === undefined) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v as Decimal.Value);
}

/** Python f"{float(x):.2f}" — but using Decimal for stability. */
export function fmt(d: Decimal, places: number): string {
  return d.toFixed(places);
}

// ----------------------------------------------------------------------------
// Burden factor (used by employee cost; ignored for freelancers)
// ----------------------------------------------------------------------------

let _burden_cache: number | null = null;
let _burden_cache_at = 0;

export async function burdenFactor(): Promise<number> {
  if (_burden_cache !== null && Date.now() - _burden_cache_at < 60_000) {
    return _burden_cache;
  }
  const r = await db.execute(sql`
    SELECT value FROM setting WHERE key = 'burden_factor'
  `);
  const row = (r.rows as Array<{ value: string }>)[0];
  const v = row ? Number(row.value) : 1.3;
  _burden_cache = v;
  _burden_cache_at = Date.now();
  return v;
}

// ----------------------------------------------------------------------------
// Entity monthly cost
// ----------------------------------------------------------------------------

export type EntityCost = {
  monthly_cost: Decimal | null;
  basis: string;
  who_name: string | null;
  /** Standard daily hours for the entity (e.g. 8 for a 40h/wk employee, 4
   * for a 20h/wk part-timer, 8 for a freelancer). Used by callers that
   * convert monthly_cost → per-hour rate so part-timers get the right
   * hourly basis instead of the hardcoded 8h/day. */
  standard_daily_hours: number;
  /** Resolved salary inputs after the as-of fallback (see
   * `_salary-resolve.ts`). Surfaced for agent endpoints that want to
   * show raw salary alongside the burdened cost — callers that don't
   * need it can ignore. `null` everywhere for freelancers. */
  resolved_salary: {
    fix: number | null;
    interval: string | null;
    hourly: number | null;
    weekly_working_hours: number | null;
    /** Which source the fields came from: 'compensation_event' when an
     * as-of event was found, 'employee_current' when the legacy column
     * was the fallback, 'none' when neither yielded a positive salary
     * (matches `basis === "no salary on file …"`). */
    source: "compensation_event" | "employee_current" | "none";
  } | null;
};

export async function entityMonthlyCost(
  employee_id: number | null,
  freelancer_id: number | null,
  daily_cost_override: Decimal | null,
  burden: number,
  /** When provided, look up the salary in effect on `month_start` from
   * `compensation_event` instead of using `employee_current`'s "now"
   * values. Makes historical / forecast monthly cost honest — a Q1
   * 2024 report should use Q1 2024 salaries, not today's. When the
   * employee has no compensation_event on or before `month_start` (no
   * Personio history sync, or hired after the date), the function
   * falls back to `employee_current` so we don't silently zero them
   * out. Omit `month_start` to preserve the legacy "use current"
   * behavior — still needed by cumulative project-cost callers that
   * span many months at once. */
  month_start?: string,
): Promise<EntityCost> {
  if (employee_id !== null) {
    // Two query shapes: bare employee_current (legacy / no month
    // context), and employee_current LEFT JOIN LATERAL the latest
    // compensation_event on or before month_start with a base-pay
    // category. Tie-break by compensation_id DESC for determinism
    // when two events share the same effective_from.
    const r =
      month_start === undefined
        ? await db.execute(sql`
            SELECT first_name, last_name,
                   fix_salary, fix_salary_interval,
                   hourly_salary, weekly_working_hours,
                   NULL::text AS asof_category,
                   NULL::numeric AS asof_amount,
                   NULL::text AS asof_interval,
                   NULL::double precision AS asof_wkh
            FROM employee_current
            WHERE employee_id = ${employee_id}
          `)
        : await db.execute(sql`
            SELECT ec.first_name, ec.last_name,
                   ec.fix_salary, ec.fix_salary_interval,
                   ec.hourly_salary, ec.weekly_working_hours,
                   ce.category AS asof_category,
                   ce.amount_value AS asof_amount,
                   ce.interval AS asof_interval,
                   ce.weekly_working_hours AS asof_wkh
            FROM employee_current ec
            LEFT JOIN LATERAL (
              SELECT category, amount_value, interval, weekly_working_hours
              FROM compensation_event
              WHERE employee_id = ec.employee_id
                AND category IN ('FIXED_SALARY', 'HOURLY_SALARY')
                AND effective_from IS NOT NULL
                AND effective_from <= ${month_start}::date
              ORDER BY effective_from DESC, compensation_id DESC
              LIMIT 1
            ) ce ON TRUE
            WHERE ec.employee_id = ${employee_id}
          `);
    const row = (r.rows as Array<Record<string, unknown>>)[0];
    if (!row) {
      return {
        monthly_cost: null,
        basis: "unknown employee",
        who_name: null,
        standard_daily_hours: 8,
        resolved_salary: null,
      };
    }
    const fn = row.first_name as string | null;
    const ln = row.last_name as string | null;
    const who = `${fn ?? ""} ${ln ?? ""}`.trim();

    const { fix, interval, hourly, wkh, asofUsed } = resolveSalaryFromRow(
      row as unknown as import("./_salary-resolve").SalaryRow,
    );
    const resolved_salary = {
      fix,
      interval,
      hourly,
      weekly_working_hours: wkh,
      source: (asofUsed
        ? "compensation_event"
        : ((fix !== null && fix > 0) || (hourly !== null && hourly > 0))
          ? "employee_current"
          : "none") as "compensation_event" | "employee_current" | "none",
    };
    // 5-day work week assumption matches the workingDaysInRange helper.
    const standard_daily_hours = wkh !== null && wkh > 0 ? wkh / 5 : 8;
    const asofTag = asofUsed
      ? ` (as-of ${month_start})`
      : month_start !== undefined
        ? ` (current; no event ≤ ${month_start})`
        : "";

    if (fix !== null && fix > 0 && interval === "yearly") {
      return {
        monthly_cost: new Decimal(fix).div(12).mul(burden),
        basis: `fix_salary ${fix.toFixed(0)}/yr × burden ×${burden}${asofTag}`,
        who_name: who,
        standard_daily_hours,
        resolved_salary,
      };
    }
    if (fix !== null && fix > 0 && interval === "monthly") {
      return {
        monthly_cost: new Decimal(fix).mul(burden),
        basis: `fix_salary ${fix.toFixed(0)}/mo × burden ×${burden}${asofTag}`,
        who_name: who,
        standard_daily_hours,
        resolved_salary,
      };
    }
    if (hourly !== null && hourly > 0 && wkh !== null && wkh > 0) {
      const cost = new Decimal(hourly).mul(wkh).mul(WEEKS_PER_MONTH).mul(burden);
      return {
        monthly_cost: cost,
        basis: `hourly ${hourly.toFixed(2)} × ${wkh}h × 52/12 × burden ×${burden}${asofTag}`,
        who_name: who,
        standard_daily_hours,
        resolved_salary,
      };
    }
    return {
      monthly_cost: null,
      basis: `no salary on file${asofTag}`,
      who_name: who,
      standard_daily_hours,
      resolved_salary,
    };
  }

  // freelancer
  if (freelancer_id === null) {
    return {
      monthly_cost: null,
      basis: "no entity",
      who_name: null,
      standard_daily_hours: 8,
      resolved_salary: null,
    };
  }
  const r = await db.execute(sql`
    SELECT name, daily_cost_eur FROM freelancer WHERE freelancer_id = ${freelancer_id}
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    return {
      monthly_cost: null,
      basis: "unknown freelancer",
      who_name: null,
      standard_daily_hours: 8,
      resolved_salary: null,
    };
  }
  const used = daily_cost_override ?? new Decimal(row.daily_cost_eur as string);
  return {
    monthly_cost: used.mul(20),
    basis: `daily ${used}/d × 20 (no burden)`,
    who_name: row.name as string,
    standard_daily_hours: 8,
    resolved_salary: null,
  };
}

// ----------------------------------------------------------------------------
// FTE
// ----------------------------------------------------------------------------

export async function employeeFte(employee_id: number): Promise<Decimal> {
  const r = await db.execute(sql`
    SELECT weekly_working_hours FROM employee_current WHERE employee_id = ${employee_id}
  `);
  const row = (r.rows as Array<{ weekly_working_hours: number | string | null }>)[0];
  if (!row || !row.weekly_working_hours) return new Decimal(1);
  return new Decimal(row.weekly_working_hours as number).div(40);
}

// ----------------------------------------------------------------------------
// Rate resolution per day (project_rate → framework_rate; override wins)
// ----------------------------------------------------------------------------

export async function resolveRateForDay(
  project_id: number,
  framework_id: number | null,
  profile: string | null,
  day: string,
  rate_override: Decimal | null,
): Promise<Decimal | null> {
  if (rate_override !== null) return rate_override;
  if (!profile) return null;
  const pr = await db.execute(sql`
    SELECT daily_rate_eur FROM project_rate
    WHERE project_id = ${project_id} AND profile = ${profile} AND valid_from <= ${day}::date
    ORDER BY valid_from DESC LIMIT 1
  `);
  const prRow = (pr.rows as Array<{ daily_rate_eur: string }>)[0];
  if (prRow) return new Decimal(prRow.daily_rate_eur);
  if (framework_id !== null) {
    const fr = await db.execute(sql`
      SELECT daily_rate_eur FROM framework_rate
      WHERE framework_id = ${framework_id} AND profile = ${profile} AND valid_from <= ${day}::date
      ORDER BY valid_from DESC LIMIT 1
    `);
    const frRow = (fr.rows as Array<{ daily_rate_eur: string }>)[0];
    if (frRow) return new Decimal(frRow.daily_rate_eur);
  }
  return null;
}

// ----------------------------------------------------------------------------
// Absences (paid + unpaid sets of workdays)
// ----------------------------------------------------------------------------

const UNPAID_TIME_OFF_KEYWORDS = [
  "unbezahlt",
  "unpaid",
  "elternzeit",
  "parental leave",
  "sabbatical",
  "unpaid leave",
];

export function isUnpaidTimeOffType(name: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return UNPAID_TIME_OFF_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Returns [all_absences, unpaid_absences] — Sets of YYYY-MM-DD weekday strings
 * inside [month_start, month_end] excluding holidays. */
export async function absencesForEmployee(
  employee_id: number,
  month_start: string,
  month_end: string,
  holidays: Map<string, string>,
): Promise<[Set<string>, Set<string>]> {
  const all_abs = new Set<string>();
  const unpaid = new Set<string>();
  const r = await db.execute(sql`
    SELECT start_date, end_date, time_off_type FROM absence
    WHERE employee_id = ${employee_id}
      AND start_date <= ${month_end}::date
      AND end_date >= ${month_start}::date
  `);
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const s = raw.start_date as string;
    const e = raw.end_date as string;
    const type_name = raw.time_off_type as string | null;
    const is_unpaid = isUnpaidTimeOffType(type_name);
    let cur = s > month_start ? s : month_start;
    const end = e < month_end ? e : month_end;
    while (cur <= end) {
      const d = new Date(cur + "T00:00:00Z").getUTCDay();
      if (d !== 0 && d !== 6 && !holidays.has(cur)) {
        all_abs.add(cur);
        if (is_unpaid) unpaid.add(cur);
      }
      cur = shiftDay(cur, 1);
    }
  }
  return [all_abs, unpaid];
}

// ----------------------------------------------------------------------------
// Σ employee weighted alloc across ALL their assignments this month
// (denominator for burdened cost)
// ----------------------------------------------------------------------------

export async function employeeWeightedAllocInMonth(
  employee_id: number,
  month_start: string,
  month_end: string,
  working_days: string[],
): Promise<Decimal> {
  const n_wd = working_days.length;
  if (n_wd === 0) return new Decimal(0);
  // Include awork-planning rows so an employee with only Planner data
  // still shows utilization. Dedup via NOT EXISTS so a (employee,
  // project) pair with BOTH manual + planning counts the manual once
  // (manual is the authoritative contract). Planning rows orphaned
  // from a manual sibling are kept.
  const r = await db.execute(sql`
    SELECT a.allocation_pct, a.start_date, a.end_date
    FROM assignment a
    WHERE a.employee_id = ${employee_id}
      AND a.start_date <= ${month_end}::date
      AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
      AND NOT (
        a.source = 'awork-planning'
        AND EXISTS (
          SELECT 1 FROM assignment m
          WHERE m.employee_id = a.employee_id
            AND m.project_id = a.project_id
            AND m.source = 'manual'
        )
      )
  `);
  let total = new Decimal(0);
  const wdSet = new Set(working_days);
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end = raw.end_date as string | null;
    const ws = a_start > month_start ? a_start : month_start;
    const we = a_end === null ? month_end : a_end < month_end ? a_end : month_end;
    let active = 0;
    for (const d of working_days) {
      if (d >= ws && d <= we && wdSet.has(d)) active++;
    }
    if (active === 0) continue;
    total = total.add(alloc.mul(active).div(n_wd));
  }
  return total;
}

// ----------------------------------------------------------------------------
// Σ project weighted alloc across all assignments on this project this month
// (denominator for FP revenue attribution per consultant)
// ----------------------------------------------------------------------------

export async function projectTotalWeightedAllocInMonth(
  project_id: number,
  month_start: string,
  month_end: string,
  working_days: string[],
): Promise<Decimal> {
  const n_wd = working_days.length;
  if (n_wd === 0) return new Decimal(0);
  // Include planning rows; dedup vs manual on (employee, project)
  // so the FP attribution denominator isn't inflated when both exist.
  const r = await db.execute(sql`
    SELECT a.allocation_pct, a.start_date, a.end_date
    FROM assignment a
    WHERE a.project_id = ${project_id}
      AND a.employee_id IS NOT NULL
      AND a.start_date <= ${month_end}::date
      AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
      AND NOT (
        a.source = 'awork-planning'
        AND EXISTS (
          SELECT 1 FROM assignment m
          WHERE m.employee_id = a.employee_id
            AND m.project_id = a.project_id
            AND m.source = 'manual'
        )
      )
  `);
  let total = new Decimal(0);
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end = raw.end_date as string | null;
    const ws = a_start > month_start ? a_start : month_start;
    const we = a_end === null ? month_end : a_end < month_end ? a_end : month_end;
    let active = 0;
    for (const d of working_days) {
      if (d >= ws && d <= we) active++;
    }
    if (active === 0) continue;
    total = total.add(alloc.mul(active).div(n_wd));
  }
  return total;
}

// ----------------------------------------------------------------------------
// Employee's TOTAL tracked minutes in a month across every project they
// touched (Personio + awork combined, deduped per day). Used as the
// denominator for proportional cost attribution — an employee who
// over-tracks doesn't get charged more than their salary, just redistributed.
// ----------------------------------------------------------------------------

export async function employeeTotalTrackedMinutesInMonth(
  employee_id: number,
  month_start: string,
  month_end: string,
): Promise<number> {
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT a.work_date, SUM(a.duration_minutes) AS minutes
      FROM attendance a
      WHERE a.employee_id = ${employee_id}
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY a.work_date
    ),
    awork AS (
      SELECT t.work_date, SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE ul.employee_id = ${employee_id}
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY t.work_date
    ),
    per_day AS (
      SELECT work_date, MAX(minutes) AS minutes
      FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
      GROUP BY work_date
    )
    SELECT COALESCE(SUM(minutes), 0) AS m FROM per_day
  `);
  const row = (r.rows as Array<{ m: number | string | null }>)[0];
  return row?.m === null || row?.m === undefined ? 0 : Number(row.m);
}

// ----------------------------------------------------------------------------
// Project-only tracked minutes — same shape as the total helper above but
// only counts entries linked to a Dante project. Powers the tracked-time
// utilization metric on the team detail roster (sibling to the
// assignment-based utilization), so under-allocation drift is visible.
// ----------------------------------------------------------------------------

/** Future planned hours on a project from `as_of` (exclusive) to
 * `planned_end_date` (inclusive). Iterates every assignment that
 * overlaps the window, multiplying its `allocation_pct × standard_daily_hours`
 * (8h default for freelancers / employees without `weekly_working_hours`)
 * by the working-day count clipped to the window. Same dedup as the
 * weighted-alloc helpers — manual wins over awork-planning on
 * `(employee, project)`. Used by the FP burn-down report and the
 * project detail page's projected-end-of-project numbers. */
export async function projectFuturePlannedHours(
  project_id: number,
  as_of: string,
  planned_end_date: string | null,
): Promise<Decimal> {
  if (planned_end_date === null) return new Decimal(0);
  const future_start = shiftDay(as_of, 1);
  if (future_start > planned_end_date) return new Decimal(0);
  const yStart = Number(future_start.slice(0, 4));
  const yEnd = Number(planned_end_date.slice(0, 4));
  const holidays = germanFederalHolidays(yStart, yEnd);
  const window_workdays = workingDaysInRange(
    future_start,
    planned_end_date,
    holidays,
  );
  if (window_workdays.length === 0) return new Decimal(0);

  const r = await db.execute(sql`
    SELECT a.employee_id, a.freelancer_id, a.allocation_pct,
           a.start_date, a.end_date,
           ec.weekly_working_hours
    FROM assignment a
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    WHERE a.project_id = ${project_id}
      AND a.start_date <= ${planned_end_date}::date
      AND (a.end_date IS NULL OR a.end_date >= ${future_start}::date)
      AND NOT (
        a.source = 'awork-planning'
        AND EXISTS (
          SELECT 1 FROM assignment m
          WHERE m.employee_id = a.employee_id
            AND m.project_id = a.project_id
            AND m.source = 'manual'
        )
      )
  `);

  let total = new Decimal(0);
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end_raw = (raw.end_date as string | null) ?? null;
    const wkh =
      raw.weekly_working_hours === null ||
      raw.weekly_working_hours === undefined
        ? null
        : Number(raw.weekly_working_hours);
    const std_daily = wkh !== null && wkh > 0 ? wkh / 5 : 8;

    const ws = a_start > future_start ? a_start : future_start;
    const we =
      a_end_raw === null || a_end_raw > planned_end_date
        ? planned_end_date
        : a_end_raw;

    const active = window_workdays.filter((d) => d >= ws && d <= we).length;
    if (active === 0) continue;
    total = total.add(alloc.mul(active).mul(std_daily));
  }
  return total;
}

export async function employeeProjectTrackedMinutesInMonth(
  employee_id: number,
  month_start: string,
  month_end: string,
): Promise<number> {
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT a.work_date, SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      WHERE a.employee_id = ${employee_id}
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY a.work_date
    ),
    awork AS (
      SELECT t.work_date, SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      WHERE ul.employee_id = ${employee_id}
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY t.work_date
    ),
    per_day AS (
      SELECT work_date, MAX(minutes) AS minutes
      FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
      GROUP BY work_date
    )
    SELECT COALESCE(SUM(minutes), 0) AS m FROM per_day
  `);
  const row = (r.rows as Array<{ m: number | string | null }>)[0];
  return row?.m === null || row?.m === undefined ? 0 : Number(row.m);
}

/** Per-project tracked minutes for a single employee in a single
 * month. Returns Map<project_id, minutes>. Mirrors
 * `employeeProjectTrackedMinutesInMonth` (which sums across every
 * mapped project) but keeps the per-project axis so per-assignment
 * revenue can multiply by the right tracked total. Personio + awork
 * with MAX dedup per (project, day) so a double-logged day doesn't
 * count twice. */
export async function trackedMinutesByProjectForEmployee(
  employee_id: number,
  month_start: string,
  month_end: string,
): Promise<Map<number, number>> {
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT pl.project_id, a.work_date,
             SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      WHERE a.employee_id = ${employee_id}
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY pl.project_id, a.work_date
    ),
    awork AS (
      SELECT apl.project_id, t.work_date,
             SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      WHERE ul.employee_id = ${employee_id}
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY apl.project_id, t.work_date
    ),
    per_project_day AS (
      SELECT project_id, work_date, MAX(minutes) AS minutes
      FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
      GROUP BY project_id, work_date
    )
    SELECT project_id, COALESCE(SUM(minutes), 0) AS m
    FROM per_project_day
    GROUP BY project_id
  `);
  const out = new Map<number, number>();
  for (const row of r.rows as Array<{
    project_id: number;
    m: number | string | null;
  }>) {
    if (row.m === null || row.m === undefined) continue;
    out.set(row.project_id, Number(row.m));
  }
  return out;
}

/** Utilization based on tracked project hours instead of assignment
 * allocation. Numerator = `employeeProjectTrackedMinutesInMonth`;
 * denominator = (contract workdays − absence workdays) ×
 * standard_daily_hours × 60. Returns null when there's no available
 * time (entirely off-contract month, or entirely on holiday/leave).
 * Returned ratio can exceed 1 — that's tracked overtime, real signal,
 * not a bug to clamp. */
export async function employeeTrackedUtilizationInMonth(
  employee_id: number,
  month_start: string,
  month_end: string,
  contract_workdays: string[],
  absences: Set<string>,
  standard_daily_hours: number,
): Promise<Decimal | null> {
  if (contract_workdays.length === 0) return null;
  const available_workdays = contract_workdays.filter(
    (d) => !absences.has(d),
  ).length;
  if (available_workdays === 0) return null;
  const available_minutes = new Decimal(available_workdays)
    .mul(standard_daily_hours)
    .mul(60);
  if (available_minutes.lte(0)) return null;
  const tracked_minutes = await employeeProjectTrackedMinutesInMonth(
    employee_id,
    month_start,
    month_end,
  );
  return new Decimal(tracked_minutes).div(available_minutes);
}

// ----------------------------------------------------------------------------
// Project tracked hours through a date (Personio + awork, MAX dedup per
// (employee, day))
// ----------------------------------------------------------------------------

export async function projectTrackedHoursThrough(
  project_id: number,
  through_date: string,
): Promise<Decimal> {
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT a.employee_id, a.work_date,
             SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      WHERE pl.project_id = ${project_id}
        AND a.work_date <= ${through_date}::date
      GROUP BY a.employee_id, a.work_date
    ),
    awork AS (
      SELECT ul.employee_id, t.work_date,
             SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE apl.project_id = ${project_id}
        AND t.work_date <= ${through_date}::date
      GROUP BY ul.employee_id, t.work_date
    ),
    merged AS (
      SELECT * FROM personio UNION ALL SELECT * FROM awork
    )
    SELECT COALESCE(SUM(per_day_minutes), 0) AS m FROM (
      SELECT MAX(minutes) AS per_day_minutes
      FROM merged
      GROUP BY employee_id, work_date
    ) s
  `);
  const row = (r.rows as Array<{ m: number | string | null }>)[0];
  if (!row || row.m === null) return new Decimal(0);
  return new Decimal(row.m as number).div(60);
}

// ----------------------------------------------------------------------------
// FP recognition through a date
// ----------------------------------------------------------------------------

export type RecognitionResult = {
  cumulative_recognized: Decimal | null;
  method: "tracked_hours" | "timeline" | "none";
  pct_complete_raw: Decimal | null;
  over_budget: boolean;
};

export async function fpRecognitionThrough(
  project_id: number,
  through_date: string,
  agreed_amount: Decimal | null,
  time_budget_hours: number | null,
  planned_start: string | null,
  planned_end: string | null,
): Promise<RecognitionResult> {
  if (agreed_amount === null) {
    return { cumulative_recognized: null, method: "none", pct_complete_raw: null, over_budget: false };
  }

  if (time_budget_hours !== null && time_budget_hours > 0) {
    const hours = await projectTrackedHoursThrough(project_id, through_date);
    const pct = hours.div(time_budget_hours);
    const raw = agreed_amount.mul(pct);
    const capped = Decimal.min(raw, agreed_amount);
    return {
      cumulative_recognized: capped,
      method: "tracked_hours",
      pct_complete_raw: pct,
      over_budget: raw.gt(agreed_amount),
    };
  }

  if (planned_start && planned_end && planned_end >= planned_start) {
    const yStart = Number(planned_start.slice(0, 4));
    const yEnd = Number(planned_end.slice(0, 4));
    const h = germanFederalHolidays(yStart, yEnd);
    const all_wd = workingDaysInRange(planned_start, planned_end, h);
    if (all_wd.length === 0) {
      return {
        cumulative_recognized: new Decimal(0),
        method: "timeline",
        pct_complete_raw: new Decimal(0),
        over_budget: false,
      };
    }
    const clipped_end = through_date < planned_end ? through_date : planned_end;
    if (clipped_end < planned_start) {
      return {
        cumulative_recognized: new Decimal(0),
        method: "timeline",
        pct_complete_raw: new Decimal(0),
        over_budget: false,
      };
    }
    const wd_through = all_wd.filter((d) => d <= clipped_end).length;
    const pct = new Decimal(wd_through).div(all_wd.length);
    const raw = agreed_amount.mul(pct);
    const capped = Decimal.min(raw, agreed_amount);
    return {
      cumulative_recognized: capped,
      method: "timeline",
      pct_complete_raw: pct,
      over_budget: false,
    };
  }

  return { cumulative_recognized: null, method: "none", pct_complete_raw: null, over_budget: false };
}

// ----------------------------------------------------------------------------
// This-month FP recognized revenue = cum(month_end) − cum(month_start − 1)
// ----------------------------------------------------------------------------

export async function fpRecognizedRevenueForMonth(
  project_id: number,
  month_start: string,
  month_end: string,
): Promise<Decimal | null> {
  const p = await db.execute(sql`
    SELECT billing_model, agreed_amount_eur, time_budget_hours,
           planned_start_date, planned_end_date
    FROM project WHERE project_id = ${project_id}
  `);
  const row = (p.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  if (row.billing_model !== "fixed_price") return null;
  const agreed =
    row.agreed_amount_eur === null || row.agreed_amount_eur === undefined
      ? null
      : new Decimal(row.agreed_amount_eur as string);
  const tbh =
    row.time_budget_hours === null || row.time_budget_hours === undefined
      ? null
      : Number(row.time_budget_hours);
  const ps = row.planned_start_date as string | null;
  const pe = row.planned_end_date as string | null;

  const now = await fpRecognitionThrough(project_id, month_end, agreed, tbh, ps, pe);
  if (now.cumulative_recognized === null) return null;
  const prev_end = shiftDay(month_start, -1);
  const prev = await fpRecognitionThrough(project_id, prev_end, agreed, tbh, ps, pe);
  const prev_cum = prev.cumulative_recognized ?? new Decimal(0);
  return now.cumulative_recognized.minus(prev_cum);
}

// ----------------------------------------------------------------------------
// Tracked minutes per employee for a (project, month) window
// ----------------------------------------------------------------------------

export async function trackedMinutesPerEmployeeInMonth(
  project_id: number,
  month_start: string,
  month_end: string,
): Promise<Map<number, number>> {
  // When a project is mapped in BOTH Personio and awork, the same hours are
  // often logged in both systems. Dedup by taking MAX(personio, awork) per
  // (employee, day) so we don't double-count. Matches projectTrackedHoursThrough.
  const r = await db.execute(sql`
    WITH personio AS (
      SELECT a.employee_id, a.work_date,
             SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      WHERE pl.project_id = ${project_id}
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY a.employee_id, a.work_date
    ),
    awork AS (
      SELECT ul.employee_id, t.work_date,
             SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE apl.project_id = ${project_id}
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY ul.employee_id, t.work_date
    ),
    per_day AS (
      SELECT employee_id, work_date, MAX(minutes) AS minutes
      FROM (
        SELECT * FROM personio
        UNION ALL
        SELECT * FROM awork
      ) u
      GROUP BY employee_id, work_date
    )
    SELECT employee_id, COALESCE(SUM(minutes), 0) AS m
    FROM per_day
    GROUP BY employee_id
  `);
  const out = new Map<number, number>();
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    if (raw.employee_id === null) continue;
    out.set(raw.employee_id as number, Number(raw.m));
  }
  return out;
}

// ----------------------------------------------------------------------------
// Project has a time-tracking mapping (Personio or awork)
// ----------------------------------------------------------------------------

export async function projectHasTimeMapping(project_id: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT (
      EXISTS (SELECT 1 FROM personio_project_link WHERE project_id = ${project_id})
      OR EXISTS (SELECT 1 FROM awork_project_link WHERE project_id = ${project_id})
    ) AS has_mapping
  `);
  const row = (r.rows as Array<{ has_mapping: boolean }>)[0];
  return Boolean(row?.has_mapping);
}

/** Lifetime billable revenue for a T&M project through `through_date`.
 *
 * Employees: lifetime tracked person-days (Personio + awork, deduped by
 * MAX per employee/day — same rule as `trackedMinutesPerEmployeeInMonth`)
 * × the assignment's effective daily rate. Freelancers: entered
 * person-days (`freelancer_time_entry.hours / 8`) × effective rate.
 *
 * Rate comes from `assignment_effective_rate`, which resolves as-of the
 * assignment's start_date. Exact when the profile's rate is constant over
 * the project (the common case — framework rates carry a single
 * valid_from); if a rate changes mid-project this is a close approximation.
 * Assignments whose rate is unresolved (`rate_source = 'unset'`)
 * contribute 0, matching the monthly views. One rate per employee via
 * DISTINCT ON so a re-assignment doesn't double-count. */
export async function cumulativeProjectRevenue(
  project_id: number,
  through_date: string,
): Promise<Decimal> {
  const r = await db.execute(sql`
    WITH per_day AS (
      SELECT employee_id, work_date, MAX(minutes) AS minutes FROM (
        SELECT a.employee_id, a.work_date, SUM(a.duration_minutes) AS minutes
        FROM attendance a
        JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
        WHERE pl.project_id = ${project_id}
          AND a.work_date <= ${through_date}::date
        GROUP BY a.employee_id, a.work_date
        UNION ALL
        SELECT ul.employee_id, t.work_date, SUM(t.duration_minutes)
        FROM awork_time_entry t
        JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
        JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
        WHERE apl.project_id = ${project_id}
          AND t.work_date <= ${through_date}::date
        GROUP BY ul.employee_id, t.work_date
      ) u GROUP BY employee_id, work_date
    ),
    emp_days AS (
      SELECT employee_id, SUM(minutes) / 60.0 / 8.0 AS person_days
      FROM per_day GROUP BY employee_id
    ),
    emp_rate AS (
      SELECT DISTINCT ON (a.employee_id)
             a.employee_id, aer.effective_daily_rate_eur AS rate
      FROM assignment a
      JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
      WHERE a.project_id = ${project_id} AND a.freelancer_id IS NULL
      ORDER BY a.employee_id, a.start_date DESC
    ),
    emp_rev AS (
      SELECT COALESCE(SUM(ed.person_days * er.rate), 0) AS rev
      FROM emp_days ed
      JOIN emp_rate er ON er.employee_id = ed.employee_id
    ),
    fl_rev AS (
      SELECT COALESCE(SUM((fte.hours_decimal / 8.0) * aer.effective_daily_rate_eur), 0) AS rev
      FROM freelancer_time_entry fte
      JOIN assignment a ON a.assignment_id = fte.assignment_id AND a.project_id = ${project_id}
      JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
      WHERE (fte.year_month || '-01')::date <= ${through_date}::date
    )
    SELECT (SELECT rev FROM emp_rev) + (SELECT rev FROM fl_rev) AS revenue
  `);
  const row = (r.rows as Array<{ revenue: string | number }>)[0];
  return row ? new Decimal(row.revenue) : new Decimal(0);
}

// ----------------------------------------------------------------------------
// Unassigned tracked rows for a project (employees who logged time but have
// no assignment row that overlaps the month)
// ----------------------------------------------------------------------------

export async function unassignedTrackedForProject(
  project_id: number,
  framework_id: number | null,
  month_start: string,
  month_end: string,
  n_working_days: number,
  billing: string,
  burden: number,
): Promise<Array<Record<string, unknown>>> {
  // Two dedup passes:
  //  1. Per (employee, day) inside this project — protects against the same
  //     hours being logged in both Personio and awork.
  //  2. Per (employee, day) across ALL projects — needed so the cost
  //     attribution denominator (Option A's `total_all_min`) reflects each
  //     person's true monthly tracked total, not double-counted hours.
  const r = await db.execute(sql`
    WITH personio_per_day AS (
      SELECT a.employee_id, a.work_date,
             SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
      WHERE pl.project_id = ${project_id}
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY a.employee_id, a.work_date
    ),
    awork_per_day AS (
      SELECT ul.employee_id, t.work_date,
             SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE apl.project_id = ${project_id}
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY ul.employee_id, t.work_date
    ),
    deduped AS (
      SELECT employee_id, work_date, MAX(minutes) AS minutes
      FROM (
        SELECT * FROM personio_per_day
        UNION ALL
        SELECT * FROM awork_per_day
      ) u
      GROUP BY employee_id, work_date
    ),
    all_tracked AS (
      SELECT d.employee_id,
             SUM(d.minutes) AS total_min,
             MAX(CASE WHEN EXISTS (SELECT 1 FROM personio_per_day p WHERE p.employee_id = d.employee_id AND p.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_personio,
             MAX(CASE WHEN EXISTS (SELECT 1 FROM awork_per_day w WHERE w.employee_id = d.employee_id AND w.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_awork
      FROM deduped d
      GROUP BY d.employee_id
    ),
    -- For each unassigned tracker, what's their TOTAL tracked across every
    -- project they touched this month (Personio + awork, deduped per day)?
    -- This is the Option A denominator.
    emp_all_personio AS (
      SELECT a.employee_id, a.work_date, SUM(a.duration_minutes) AS minutes
      FROM attendance a
      WHERE a.employee_id IN (SELECT employee_id FROM all_tracked)
        AND a.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY a.employee_id, a.work_date
    ),
    emp_all_awork AS (
      SELECT ul.employee_id, t.work_date, SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
      WHERE ul.employee_id IN (SELECT employee_id FROM all_tracked)
        AND t.work_date BETWEEN ${month_start}::date AND ${month_end}::date
      GROUP BY ul.employee_id, t.work_date
    ),
    emp_all_deduped AS (
      SELECT employee_id, work_date, MAX(minutes) AS minutes
      FROM (SELECT * FROM emp_all_personio UNION ALL SELECT * FROM emp_all_awork) u
      GROUP BY employee_id, work_date
    ),
    emp_all_total AS (
      SELECT employee_id, SUM(minutes) AS total_all_min
      FROM emp_all_deduped
      GROUP BY employee_id
    )
    SELECT
      t.employee_id,
      ec.first_name || ' ' || ec.last_name AS who_name,
      t.total_min,
      t.has_personio,
      t.has_awork,
      rt.role_tier,
      ea.total_all_min
    FROM all_tracked t
    LEFT JOIN employee_current ec ON ec.employee_id = t.employee_id
    LEFT JOIN employee_role_tier rt ON rt.employee_id = t.employee_id
    LEFT JOIN emp_all_total ea ON ea.employee_id = t.employee_id
    WHERE t.total_min > 0
      AND NOT EXISTS (
        SELECT 1 FROM assignment a
        WHERE a.employee_id = t.employee_id
          AND a.project_id = ${project_id}
          AND a.start_date <= ${month_end}::date
          AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
      )
    ORDER BY t.total_min DESC
  `);

  const out: Array<Record<string, unknown>> = [];
  for (const raw of r.rows as Array<Record<string, unknown>>) {
    const emp_id = raw.employee_id as number | null;
    const total_min = Number(raw.total_min ?? 0);
    const hours = Math.round(total_min / 60);
    if (hours === 0) continue;
    const days_dec = new Decimal(hours).div(8);

    let revenue = new Decimal(0);
    let rate_unresolved_days = 0;
    if (billing === "time_and_material") {
      let rate: Decimal | null = null;
      const role_tier = raw.role_tier as string | null;
      if (role_tier) {
        rate = await resolveRateForDay(
          project_id,
          framework_id,
          role_tier,
          month_start,
          null,
        );
      }
      if (rate !== null) {
        revenue = rate.mul(days_dec);
      } else {
        rate_unresolved_days = Math.round(Number(days_dec.toString()));
      }
    }

    let cost = new Decimal(0);
    if (emp_id !== null && n_working_days > 0) {
      const { monthly_cost, standard_daily_hours } = await entityMonthlyCost(
        emp_id,
        null,
        null,
        burden,
        month_start,
      );
      if (monthly_cost !== null) {
        // Option A — proportional cap. Denominator is max(employee's TOTAL
        // tracked hours across every project, FTE-aware standard month).
        // Mirrors the main assignment loop in app/api/projects/[id]/monthly.
        const this_min = total_min;
        const total_all_min = Number(raw.total_all_min ?? this_min);
        const total_all_h = new Decimal(total_all_min).div(60);
        const standard_monthly_h = new Decimal(n_working_days).mul(
          standard_daily_hours,
        );
        const denom = total_all_h.gt(standard_monthly_h)
          ? total_all_h
          : standard_monthly_h;
        cost = monthly_cost.mul(new Decimal(this_min).div(60)).div(denom);
        if (cost.gt(monthly_cost)) cost = monthly_cost;
      }
    }

    const margin =
      billing === "time_and_material" ? revenue.sub(cost) : null;

    const sources: string[] = [];
    if (Number(raw.has_personio) === 1) sources.push("personio");
    if (Number(raw.has_awork) === 1) sources.push("awork");

    out.push({
      employee_id: emp_id,
      who_name: raw.who_name,
      role_tier: raw.role_tier,
      tracked_hours: `${hours}`,
      tracked_days: days_dec.toFixed(3),
      sources,
      revenue:
        billing === "time_and_material" ? revenue.toFixed(2) : null,
      cost: cost.toFixed(2),
      margin: margin === null ? null : margin.toFixed(2),
      rate_unresolved_days,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Cumulative project cost (direct) — through end of a given month
// ----------------------------------------------------------------------------

export async function cumulativeProjectCost(
  project_id: number,
  through_month_end: string,
  burden: number,
): Promise<Decimal> {
  const has_time_mapping = await projectHasTimeMapping(project_id);
  // Include planning rows; dedup vs manual on (employee, project) so
  // cumulative cost isn't doubled when both exist for the same pair.
  const asnRes = await db.execute(sql`
    SELECT a.assignment_id, a.employee_id, a.freelancer_id, a.allocation_pct,
           a.start_date, a.end_date, a.daily_cost_override_eur,
           ec.office AS employee_office
    FROM assignment a
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    WHERE a.project_id = ${project_id}
      AND NOT (
        a.source = 'awork-planning'
        AND EXISTS (
          SELECT 1 FROM assignment m
          WHERE m.employee_id = a.employee_id
            AND m.project_id = a.project_id
            AND m.source = 'manual'
        )
      )
  `);

  // Pre-load freelancer monthly hours so the freelancer branch below can
  // override allocation-based cost with actual hours when an entry exists.
  // Both manual + awork-sourced rows count — the action layer guarantees
  // only one row per (assignment, month). Empty map for projects with no
  // freelancer assignments — that's the common case.
  const freelancerHoursRes = await db.execute(sql`
    SELECT fte.assignment_id, fte.year_month, fte.hours_decimal
    FROM freelancer_time_entry fte
    JOIN assignment a ON a.assignment_id = fte.assignment_id
    WHERE a.project_id = ${project_id}
  `);
  const freelancerHours = new Map<string, Decimal>();
  for (const r of freelancerHoursRes.rows as Array<Record<string, unknown>>) {
    freelancerHours.set(
      `${r.assignment_id}|${r.year_month}`,
      new Decimal(r.hours_decimal as string),
    );
  }

  // Per-(state, year) holiday cache and per-(state, m_start) working-days
  // cache. State code is derived per assignment from the employee's office
  // — federal-only for freelancers and employees with unknown/foreign
  // offices (stateCode === null → key "DE").
  const holidayCache = new Map<string, Map<string, string>>();
  const wdCache = new Map<string, string[]>();
  function holidayFor(
    stateCode: string | null,
    year: number,
  ): Map<string, string> {
    const key = `${stateCode ?? "DE"}|${year}`;
    let h = holidayCache.get(key);
    if (!h) {
      h = germanHolidaysForStateCached(stateCode, year, year);
      holidayCache.set(key, h);
    }
    return h;
  }
  function wdFor(
    stateCode: string | null,
    m_start: string,
    m_end: string,
  ): string[] {
    const key = `${stateCode ?? "DE"}|${m_start}`;
    let wd = wdCache.get(key);
    if (!wd) {
      const y = Number(m_start.slice(0, 4));
      wd = workingDaysInRange(m_start, m_end, holidayFor(stateCode, y));
      wdCache.set(key, wd);
    }
    return wd;
  }

  let total = new Decimal(0);
  for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
    const assignment_id = raw.assignment_id as number;
    const emp_id = raw.employee_id as number | null;
    const fl_id = raw.freelancer_id as number | null;
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end = raw.end_date as string | null;
    const empStateCode = stateCodeForOffice(
      raw.employee_office as string | null,
    );
    const cost_ov =
      raw.daily_cost_override_eur === null ||
      raw.daily_cost_override_eur === undefined
        ? null
        : new Decimal(raw.daily_cost_override_eur as string);

    // TODO(as-of-rate): cumulative project cost iterates an assignment
    // across many months. Honest pricing requires looking up each
    // (employee, month)'s salary separately; the current single-rate
    // approximation here uses "now" across the full window. Acceptable
    // for FP lifetime margin display; revisit when CFO asks for true
    // historical cumulative numbers.
    const { monthly_cost, standard_daily_hours } = await entityMonthlyCost(
      emp_id,
      fl_id,
      cost_ov,
      burden,
    );
    if (monthly_cost === null) continue;
    const a_end_eff =
      a_end !== null && a_end < through_month_end ? a_end : through_month_end;
    if (a_end_eff < a_start) continue;

    let cur_month = firstOfMonth(a_start);
    while (cur_month <= a_end_eff) {
      const m_start = cur_month;
      const m_end = lastOfMonth(cur_month);
      const window_start = a_start > m_start ? a_start : m_start;
      const window_end = a_end_eff < m_end ? a_end_eff : m_end;
      const wd = wdFor(empStateCode, m_start, m_end);
      const full_month_wd = wd.length;
      const active_wd = wd.filter(
        (d) => d >= window_start && d <= window_end,
      ).length;
      if (full_month_wd === 0 || active_wd === 0) {
        cur_month = firstOfNextMonth(cur_month);
        continue;
      }
      // Freelancer with entered hours for this month → use them instead
      // of the allocation-based estimate. The hours table stores manual
      // and awork-rollup rows interchangeably; either way it's "actual".
      const fl_hours_key = `${assignment_id}|${m_start.slice(0, 7)}`;
      const fl_entered_hours =
        emp_id === null ? freelancerHours.get(fl_hours_key) : undefined;
      if (fl_entered_hours !== undefined) {
        // monthly_cost = daily_cost × 20 (see entityMonthlyCost freelancer
        // branch). cost-per-hour = monthly_cost / (20 × standard_daily_hours).
        const cost_per_hour = monthly_cost
          .div(20)
          .div(standard_daily_hours);
        total = total.add(cost_per_hour.mul(fl_entered_hours));
      } else if (has_time_mapping && emp_id !== null) {
        const tm = await trackedMinutesPerEmployeeInMonth(project_id, m_start, m_end);
        const tracked = tm.get(emp_id) ?? 0;
        if (tracked > 0) {
          const effective_hourly = monthly_cost
            .div(full_month_wd)
            .div(standard_daily_hours);
          let share = effective_hourly.mul(new Decimal(tracked).div(60));
          if (share.gt(monthly_cost)) share = monthly_cost;
          total = total.add(share);
        }
      } else if (emp_id !== null) {
        // Employee without time-mapping — allocation-based cost. NOT a
        // freelancer branch: a freelancer with no entered-hours row for
        // this month contributes 0 (pay-as-they-work), matching the
        // monthly view. Falling through to allocation here charged
        // freelancers `daily_cost × 20 × alloc` for months they never
        // billed, which massively inflated lifetime cost and tanked
        // margin on freelancer-heavy projects.
        const y = Number(m_start.slice(0, 4));
        const [, unpaid] = await absencesForEmployee(
          emp_id,
          window_start,
          window_end,
          holidayFor(empStateCode, y),
        );
        const paid_active_wd = active_wd - unpaid.size;
        if (paid_active_wd > 0) {
          total = total.add(
            monthly_cost.mul(alloc).mul(paid_active_wd).div(full_month_wd),
          );
        }
      }
      // Freelancer with no entered-hours row: contributes 0.
      cur_month = firstOfNextMonth(cur_month);
    }
  }
  return total;
}

// ----------------------------------------------------------------------------
// Cumulative project burdened cost (full salary × share of weighted alloc)
// ----------------------------------------------------------------------------

export async function cumulativeProjectBurdenedCost(
  project_id: number,
  through_month_end: string,
  burden: number,
): Promise<Decimal> {
  // Same dedup pattern as `cumulativeProjectCost`. Manual wins when
  // both exist for a given (employee, project); orphan planning rows
  // still contribute so awork-only projects accumulate cost.
  const asnRes = await db.execute(sql`
    SELECT a.assignment_id, a.employee_id, a.freelancer_id, a.allocation_pct,
           a.start_date, a.end_date, a.daily_cost_override_eur,
           ec.office AS employee_office
    FROM assignment a
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    WHERE a.project_id = ${project_id}
      AND NOT (
        a.source = 'awork-planning'
        AND EXISTS (
          SELECT 1 FROM assignment m
          WHERE m.employee_id = a.employee_id
            AND m.project_id = a.project_id
            AND m.source = 'manual'
        )
      )
  `);

  // Same freelancer-hours override path as cumulativeProjectCost — see
  // the comment there. Freelancer cost is unaffected by burden so the
  // override formula is identical here.
  const freelancerHoursRes = await db.execute(sql`
    SELECT fte.assignment_id, fte.year_month, fte.hours_decimal
    FROM freelancer_time_entry fte
    JOIN assignment a ON a.assignment_id = fte.assignment_id
    WHERE a.project_id = ${project_id}
  `);
  const freelancerHours = new Map<string, Decimal>();
  for (const r of freelancerHoursRes.rows as Array<Record<string, unknown>>) {
    freelancerHours.set(
      `${r.assignment_id}|${r.year_month}`,
      new Decimal(r.hours_decimal as string),
    );
  }

  // Per-(state, year) cache — same shape as cumulativeProjectCost.
  const holidayCache = new Map<string, Map<string, string>>();
  const wdCache = new Map<string, string[]>();
  const weightedAllocCache = new Map<string, Decimal>();
  function holidayFor(
    stateCode: string | null,
    year: number,
  ): Map<string, string> {
    const key = `${stateCode ?? "DE"}|${year}`;
    let h = holidayCache.get(key);
    if (!h) {
      h = germanHolidaysForStateCached(stateCode, year, year);
      holidayCache.set(key, h);
    }
    return h;
  }
  function wdFor(
    stateCode: string | null,
    m_start: string,
    m_end: string,
  ): string[] {
    const key = `${stateCode ?? "DE"}|${m_start}`;
    let wd = wdCache.get(key);
    if (!wd) {
      const y = Number(m_start.slice(0, 4));
      wd = workingDaysInRange(m_start, m_end, holidayFor(stateCode, y));
      wdCache.set(key, wd);
    }
    return wd;
  }

  let total = new Decimal(0);
  for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
    const assignment_id = raw.assignment_id as number;
    const emp_id = raw.employee_id as number | null;
    const fl_id = raw.freelancer_id as number | null;
    const alloc = new Decimal(raw.allocation_pct as string);
    const a_start = raw.start_date as string;
    const a_end = raw.end_date as string | null;
    const empStateCode = stateCodeForOffice(
      raw.employee_office as string | null,
    );
    const cost_ov =
      raw.daily_cost_override_eur === null ||
      raw.daily_cost_override_eur === undefined
        ? null
        : new Decimal(raw.daily_cost_override_eur as string);

    // TODO(as-of-rate): same caveat as cumulativeProjectCost — the
    // burdened lifetime sum uses today's salary across all months
    // within an assignment. Fix in lock-step with the cumulative
    // cost helper.
    const { monthly_cost, standard_daily_hours } = await entityMonthlyCost(emp_id, fl_id, cost_ov, burden);
    if (monthly_cost === null) continue;
    const a_end_eff =
      a_end !== null && a_end < through_month_end ? a_end : through_month_end;
    if (a_end_eff < a_start) continue;

    let cur_month = firstOfMonth(a_start);
    while (cur_month <= a_end_eff) {
      const m_start = cur_month;
      const m_end = lastOfMonth(cur_month);
      const window_start = a_start > m_start ? a_start : m_start;
      const window_end = a_end_eff < m_end ? a_end_eff : m_end;
      const working_days = wdFor(empStateCode, m_start, m_end);
      const full_month_wd = working_days.length;
      const active_wd = working_days.filter(
        (d) => d >= window_start && d <= window_end,
      ).length;
      if (full_month_wd === 0 || active_wd === 0) {
        cur_month = firstOfNextMonth(cur_month);
        continue;
      }
      const weighted_alloc_i = alloc.mul(active_wd).div(full_month_wd);
      if (emp_id === null) {
        const fl_hours_key = `${assignment_id}|${m_start.slice(0, 7)}`;
        const fl_entered_hours = freelancerHours.get(fl_hours_key);
        if (fl_entered_hours !== undefined) {
          const cost_per_hour = monthly_cost
            .div(20)
            .div(standard_daily_hours);
          total = total.add(cost_per_hour.mul(fl_entered_hours));
        }
        // Freelancer with no entered-hours row: contributes 0 — they only
        // cost money when they work. (Previously charged
        // monthly_cost × weighted_alloc, inflating lifetime burdened cost.)
      } else {
        const key = `${emp_id}|${m_start}`;
        let total_W = weightedAllocCache.get(key);
        if (total_W === undefined) {
          total_W = await employeeWeightedAllocInMonth(
            emp_id,
            m_start,
            m_end,
            working_days,
          );
          weightedAllocCache.set(key, total_W);
        }
        if (total_W.gt(0)) {
          const y = Number(m_start.slice(0, 4));
          const [, unpaid] = await absencesForEmployee(
            emp_id,
            m_start,
            m_end,
            holidayFor(empStateCode, y),
          );
          const paid_share = new Decimal(full_month_wd - unpaid.size).div(
            full_month_wd,
          );
          const effective_monthly_cost = monthly_cost.mul(paid_share);
          total = total.add(
            effective_monthly_cost.mul(weighted_alloc_i).div(total_W),
          );
        }
      }
      cur_month = firstOfNextMonth(cur_month);
    }
  }
  return total;
}
