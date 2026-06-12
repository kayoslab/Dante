import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import {
  germanFederalHolidays,
  germanHolidaysForState,
  stateCodeForOffice,
} from "@/lib/db/_de-holidays";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

const MAX_WINDOW_DAYS = 400;

function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
  );
}

function* dateRange(start: string, end: string): Iterable<string> {
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function bankerHours(min: number): number {
  // Same banker's rounding semantics as Python's `int(round(min/60))`
  const n = min / 60;
  const f = Math.floor(n);
  const diff = n - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export async function GET(req: NextRequest) {
  return handle(async () => {
    await requireApiSession();
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start") ?? "";
    const end = searchParams.get("end") ?? "";
    const include_non_contributing =
      (searchParams.get("include_non_contributing") ?? "false").toLowerCase() ===
      "true";
    if (!isISODate(start) || !isISODate(end)) {
      throw Validation("start and end must be ISO YYYY-MM-DD dates");
    }
    if (new Date(end) < new Date(start)) {
      throw Validation("end must be on or after start");
    }
    if (daysBetween(start, end) > MAX_WINDOW_DAYS) {
      throw Validation(
        `window exceeds ${MAX_WINDOW_DAYS} days; paginate the request`,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const holidays = germanFederalHolidays(
      Number(start.slice(0, 4)),
      Number(end.slice(0, 4)),
    );

    // 1) Days in the window
    const days = [...dateRange(start, end)].map((iso) => {
      const wd = new Date(iso).getUTCDay(); // 0=Sun, 6=Sat
      return {
        date: iso,
        weekend: wd === 0 || wd === 6,
        today: iso === today,
        public_holiday: holidays.get(iso) ?? null,
      };
    });

    // 2) Employees visible on the grid
    const contribFilter = include_non_contributing
      ? sql``
      : sql` AND COALESCE(a.is_project_contributing, TRUE) = TRUE`;
    const empRes = await db.execute(sql`
      SELECT ec.employee_id, ec.first_name, ec.last_name,
             CASE WHEN ec.weekly_working_hours IS NULL OR ec.weekly_working_hours = 0
                  THEN NULL
                  ELSE CAST(ec.weekly_working_hours / 40.0 AS NUMERIC(5, 3))
             END AS fte,
             a.team_user,
             rt.role_tier,
             ec.office,
             ec.hire_date,
             LEAST(
                 COALESCE(ec.contract_end_date, DATE '9999-12-31'),
                 COALESCE(ec.employment_end_date, DATE '9999-12-31')
             ) AS effective_end_date
      FROM employee_current ec
      LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
      LEFT JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id
      WHERE ec.status = 'active'
        AND COALESCE(a.is_real_employee, TRUE) = TRUE
        AND (ec.hire_date IS NULL OR ec.hire_date <= ${end}::date)
        AND LEAST(
            COALESCE(ec.contract_end_date, DATE '9999-12-31'),
            COALESCE(ec.employment_end_date, DATE '9999-12-31')
        ) >= ${start}::date
        ${contribFilter}
      ORDER BY a.team_user NULLS LAST, ec.last_name, ec.first_name
    `);

    const employeeIds = new Set<number>();
    // Per-employee state code for local-holiday lookups below. Stored
    // separately from the public response so we don't leak office strings
    // unnecessarily — the UI only needs the rendered holiday name.
    const employeeStateCode = new Map<number, string | null>();
    const employees = (empRes.rows as Array<Record<string, unknown>>).map((r) => {
      const empId = r.employee_id as number;
      employeeIds.add(empId);
      employeeStateCode.set(
        empId,
        stateCodeForOffice(r.office as string | null),
      );
      const endIso = r.effective_end_date as string | null;
      return {
        employee_id: r.employee_id,
        first_name: r.first_name,
        last_name: r.last_name,
        fte: r.fte === null || r.fte === undefined ? null : Number(r.fte),
        team: r.team_user,
        role_tier: r.role_tier,
        hire_date: r.hire_date,
        contract_end_date:
          endIso && !endIso.startsWith("9999") ? endIso : null,
      };
    });
    if (employeeIds.size === 0) {
      return { start, end, days, employees: [], cells: [] };
    }

    // Per-state holiday set, computed once per unique state code on the
    // grid. The set returned by `germanHolidaysForState` already includes
    // federal holidays — we subtract them when emitting per-cell so the
    // existing column-level `public_holiday` field handles the federal
    // case and `local_public_holiday` only surfaces the *additional*
    // state holidays (Fronleichnam, Heilige Drei Könige, etc.).
    const yearStart = Number(start.slice(0, 4));
    const yearEnd = Number(end.slice(0, 4));
    const localHolidayByState = new Map<string, Map<string, string>>();
    for (const code of new Set(employeeStateCode.values())) {
      if (code === null) continue;
      const stateAll = germanHolidaysForState(code, yearStart, yearEnd);
      const stateOnly = new Map<string, string>();
      for (const [date, name] of stateAll) {
        if (!holidays.has(date)) stateOnly.set(date, name);
      }
      localHolidayByState.set(code, stateOnly);
    }

    // 3) Assignment day-expansion
    const asnRes = await db.execute(sql`
      WITH date_range AS (
        SELECT generate_series(${start}::date, ${end}::date, '1 day'::interval)::date AS day
      )
      SELECT
        a.employee_id,
        d.day,
        a.assignment_id,
        CAST(a.allocation_pct AS double precision) AS allocation_pct,
        c.name AS customer_name,
        p.name AS project_name,
        COALESCE(a.profile, rt.role_tier) AS profile,
        aer.effective_daily_rate_eur
      FROM assignment a
      CROSS JOIN date_range d
      JOIN project p ON p.project_id = a.project_id
      JOIN customer c ON c.customer_id = p.customer_id
      LEFT JOIN employee_role_tier rt ON rt.employee_id = a.employee_id
      LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
      WHERE a.employee_id IS NOT NULL
        AND a.start_date <= d.day
        AND (a.end_date IS NULL OR a.end_date >= d.day)
    `);

    // 4) Tracked time (Personio + awork)
    const trkRes = await db.execute(sql`
      WITH personio AS (
        SELECT a.employee_id, a.work_date,
               COALESCE(pp.name, 'Untagged') AS project_name,
               SUM(a.duration_minutes) AS minutes,
               'personio' AS source
        FROM attendance a
        LEFT JOIN personio_project pp ON pp.personio_project_id = a.project_id
        WHERE a.work_date BETWEEN ${start}::date AND ${end}::date
        GROUP BY a.employee_id, a.work_date, pp.name
      ),
      awork AS (
        SELECT ul.employee_id, t.work_date,
               COALESCE(ap.name, 'Untagged') AS project_name,
               SUM(t.duration_minutes) AS minutes,
               'awork' AS source
        FROM awork_time_entry t
        JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
        LEFT JOIN awork_project ap ON ap.awork_project_id = t.awork_project_id
        WHERE t.work_date BETWEEN ${start}::date AND ${end}::date
        GROUP BY ul.employee_id, t.work_date, ap.name
      )
      SELECT employee_id, work_date, project_name, minutes, source
      FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
      ORDER BY employee_id, work_date
    `);

    // 5) Vacations
    const vacRes = await db.execute(sql`
      WITH date_range AS (
        SELECT generate_series(${start}::date, ${end}::date, '1 day'::interval)::date AS day
      )
      SELECT abs.employee_id, d.day, abs.time_off_type
      FROM absence abs
      CROSS JOIN date_range d
      WHERE d.day BETWEEN abs.start_date AND abs.end_date
    `);

    // 6) Aggregate into cells
    type Cell = {
      employee_id: number;
      date: string;
      allocation_pct: number;
      on_vacation: boolean;
      vacation_type: string | null;
      local_public_holiday: string | null;
      assignments: Array<{
        assignment_id: number;
        customer_name: string;
        project_name: string;
        profile: string | null;
        allocation_pct: string;
        daily_rate_eur: string | null;
      }>;
      personio_minutes_raw: number;
      awork_minutes_raw: number;
      tracked_entries: Array<{
        project_name: string;
        hours: number;
        source: string;
      }>;
    };

    const cellMap = new Map<string, Cell>();
    const cellFor = (emp_id: number, iso_day: string): Cell => {
      const key = `${emp_id}|${iso_day}`;
      let c = cellMap.get(key);
      if (!c) {
        // Resolve the state-only public holiday at cell creation time so
        // the value is set even on otherwise-empty cells (an employee on
        // Fronleichnam with no assignment + no vacation still needs the
        // amber tint).
        const stateCode = employeeStateCode.get(emp_id) ?? null;
        const localName =
          stateCode === null
            ? null
            : localHolidayByState.get(stateCode)?.get(iso_day) ?? null;
        c = {
          employee_id: emp_id,
          date: iso_day,
          allocation_pct: 0,
          on_vacation: false,
          vacation_type: null,
          local_public_holiday: localName,
          assignments: [],
          personio_minutes_raw: 0,
          awork_minutes_raw: 0,
          tracked_entries: [],
        };
        cellMap.set(key, c);
      }
      return c;
    };

    // Ensure every (employee, day-with-state-holiday) cell exists so the
    // calendar grid can render the local holiday tint even when nothing
    // else (assignment, absence, tracked time) lives on that cell.
    for (const emp_id of employeeIds) {
      const stateCode = employeeStateCode.get(emp_id) ?? null;
      if (stateCode === null) continue;
      const stateHolidays = localHolidayByState.get(stateCode);
      if (!stateHolidays) continue;
      for (const iso_day of stateHolidays.keys()) {
        if (iso_day >= start && iso_day <= end) cellFor(emp_id, iso_day);
      }
    }

    for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
      const emp_id = raw.employee_id as number;
      if (!employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.day as string);
      const alloc = Number(raw.allocation_pct);
      c.allocation_pct += alloc;
      c.assignments.push({
        assignment_id: raw.assignment_id as number,
        customer_name: raw.customer_name as string,
        project_name: raw.project_name as string,
        profile: (raw.profile as string | null) ?? null,
        allocation_pct: alloc.toFixed(4),
        daily_rate_eur:
          raw.effective_daily_rate_eur === null ||
          raw.effective_daily_rate_eur === undefined
            ? null
            : String(raw.effective_daily_rate_eur),
      });
    }

    for (const raw of trkRes.rows as Array<Record<string, unknown>>) {
      const emp_id = raw.employee_id as number | null;
      if (emp_id === null || !employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.work_date as string);
      const mins = Number(raw.minutes ?? 0);
      if (raw.source === "personio") c.personio_minutes_raw += mins;
      else c.awork_minutes_raw += mins;
      c.tracked_entries.push({
        project_name: raw.project_name as string,
        hours: bankerHours(mins),
        source: raw.source as string,
      });
    }

    for (const raw of vacRes.rows as Array<Record<string, unknown>>) {
      const emp_id = raw.employee_id as number;
      if (!employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.day as string);
      c.on_vacation = true;
      if (c.vacation_type === null) {
        c.vacation_type = (raw.time_off_type as string | null) ?? null;
      }
    }

    const cell_list = [...cellMap.values()]
      .sort((a, b) => {
        if (a.employee_id !== b.employee_id) {
          return a.employee_id - b.employee_id;
        }
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      })
      .map((c) => {
        const personio_h = bankerHours(c.personio_minutes_raw);
        const awork_h = bankerHours(c.awork_minutes_raw);
        const tracked_entries = c.tracked_entries
          .filter((e) => e.hours > 0)
          .sort((a, b) => b.hours - a.hours);
        return {
          employee_id: c.employee_id,
          date: c.date,
          allocation_pct: c.allocation_pct.toFixed(4),
          on_vacation: c.on_vacation,
          vacation_type: c.vacation_type,
          assignments: c.assignments,
          tracked_hours: Math.max(personio_h, awork_h),
          tracked_entries,
          local_public_holiday: c.local_public_holiday,
        };
      });

    return { start, end, days, employees, cells: cell_list };
  });
}
