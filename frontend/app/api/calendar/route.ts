import type { NextRequest } from "next/server";

import {
  germanFederalHolidays,
  germanHolidaysForState,
  stateCodeForOffice,
} from "@/lib/db/_de-holidays";
import {
  listCalendarAbsences,
  listCalendarAssignments,
  listCalendarEmployees,
  listCalendarPlannedBookings,
  listCalendarTrackedTime,
} from "@/lib/db/queries/calendar";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import {
  bucketKey,
  computeLoad,
  loadKindFor,
  type ProjectLoadBucket,
} from "@/lib/api/_calendar-load";

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
    const ctx = await requireApiSession();
    // The calendar is visible to every signed-in user. Sensitive fields
    // (daily rates, hire / contract dates, role tier, the actual absence
    // type) are filtered for non-managers below. Vacation type is *always*
    // collapsed to "absence" — even for managers — so "Krankheit /
    // Sickness" (GDPR Art. 9 health data) never leaks through this view.
    // Calendar runs 5 CTEs over up to a 400-day window — the heaviest
    // read endpoint. Tag it expensive so a sustained loop can't starve
    // the 5-connection pool.
    enforceRateLimit(ctx, "calendar", "expensive");
    const isManagerOrAdmin = ctx.role === "manager" || ctx.role === "admin";
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
    const empRows = await listCalendarEmployees({
      start,
      end,
      include_non_contributing,
    });

    const employeeIds = new Set<number>();
    // Per-employee state code for local-holiday lookups below. Stored
    // separately from the public response so we don't leak office strings
    // unnecessarily — the UI only needs the rendered holiday name.
    const employeeStateCode = new Map<number, string | null>();
    const employees = empRows.map((r) => {
      const empId = r.employee_id;
      employeeIds.add(empId);
      employeeStateCode.set(empId, stateCodeForOffice(r.office));
      const endIso = r.effective_end_date;
      // Strip HR-sensitive fields for non-managers (contract end date,
      // hire date, role tier). FTE + team stay visible because they
      // drive useful "who's available right now" signals that the
      // calendar is built around.
      return {
        employee_id: r.employee_id,
        first_name: r.first_name,
        last_name: r.last_name,
        fte: r.fte,
        team: r.team_user,
        role_tier: isManagerOrAdmin ? r.role_tier : null,
        hire_date: isManagerOrAdmin ? r.hire_date : null,
        contract_end_date: isManagerOrAdmin
          ? endIso && !endIso.startsWith("9999")
            ? endIso
            : null
          : null,
      };
    });
    if (employeeIds.size === 0) {
      return { start, end, days, employees: [], cells: [] };
    }

    // NOTE: cell load is NOT scaled by the employee's weekly FTE. Capacity
    // is a fixed 8h day for everyone — part-timers work full days on fewer
    // days, so dividing an 8h booking by 0.8 painted every working day of
    // theirs red. The FTE badge on the grid row carries that information
    // instead. See lib/api/_calendar-load.ts.

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
    const asnRows = await listCalendarAssignments({ start, end });

    // 4) Tracked time (Personio + awork)
    const trkRows = await listCalendarTrackedTime({ start, end });

    // 4b) Per-day planned breakdown for the tooltip. The same data
    // already feeds `assignment.allocation_pct` via the sync rollup
    // (so it drives the cell color), but the operator wants to see
    // exactly what hours are scheduled for which project each day —
    // surface that separately. Divisor uses the FULL booking range
    // (not the calendar window) so a booking that straddles the
    // window's edge doesn't inflate the visible days' share.
    const plnRows = await listCalendarPlannedBookings({ start, end });

    // 5) Vacations
    const vacRows = await listCalendarAbsences({ start, end });

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
      planned_entries: Array<{
        project_name: string;
        hours: number;
      }>;
      // Per-project rollup of all load signals. See bucketKey + the
      // computeLoad doc in lib/api/_calendar-load.ts: future days score
      // the plan (max-per-project / sum-across-projects), past days score
      // awork tracked hours only.
      project_load: Map<string, ProjectLoadBucket>;
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
          planned_entries: [],
          project_load: new Map(),
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

    const getBucket = (c: Cell, key: string) => {
      let b = c.project_load.get(key);
      if (!b) {
        b = { manual: 0, planned_h: 0, awork_tracked_h: 0 };
        c.project_load.set(key, b);
      }
      return b;
    };

    for (const raw of asnRows) {
      const emp_id = raw.employee_id;
      if (!employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.day);
      const alloc = raw.allocation_pct;
      c.allocation_pct += alloc;
      getBucket(c, bucketKey(raw.project_id)).manual += alloc;
      // Daily rate is commercial-confidential — surface to managers/admins
      // only. Customer + project names stay visible so an employee can
      // tell who's working on what (useful for cross-team awareness).
      c.assignments.push({
        assignment_id: raw.assignment_id,
        customer_name: raw.customer_name,
        project_name: raw.project_name,
        profile: raw.profile,
        allocation_pct: alloc.toFixed(4),
        daily_rate_eur: isManagerOrAdmin ? raw.effective_daily_rate_eur : null,
      });
    }

    for (const raw of trkRows) {
      const emp_id = raw.employee_id;
      if (emp_id === null || !employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.work_date);
      const mins = raw.minutes;
      if (raw.source === "personio") {
        c.personio_minutes_raw += mins;
      } else {
        // awork tracked time contributes to the project bucket so the
        // load math can take max(manual, planned, awork_tracked) at
        // the project level. Personio is intentionally excluded — it
        // backs the corner number, not the color signal.
        c.awork_minutes_raw += mins;
        const key = bucketKey(raw.dante_project_id, raw.awork_project_id);
        getBucket(c, key).awork_tracked_h += mins / 60;
      }
      c.tracked_entries.push({
        project_name: raw.project_name,
        hours: bankerHours(mins),
        source: raw.source,
      });
    }

    // Aggregate planned bookings into both project_load (for the
    // load math) and planned_entries (for the tooltip). The per-cell
    // map collapses multiple bookings on the same project into one
    // entry; flushed to the array below after the loop.
    const plannedSeen = new Map<Cell, Map<string, number>>();
    for (const raw of plnRows) {
      const emp_id = raw.employee_id;
      if (emp_id === null || !employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.day);
      const sec = raw.per_day_seconds;
      const bkey = bucketKey(raw.dante_project_id, raw.awork_project_id);
      getBucket(c, bkey).planned_h += sec / 3600;
      const nameKey = raw.project_name;
      let perCell = plannedSeen.get(c);
      if (!perCell) {
        perCell = new Map();
        plannedSeen.set(c, perCell);
      }
      perCell.set(nameKey, (perCell.get(nameKey) ?? 0) + sec);
    }
    for (const [c, perCell] of plannedSeen) {
      for (const [project_name, sec] of perCell) {
        c.planned_entries.push({
          project_name,
          hours: Math.round((sec / 3600) * 10) / 10,
        });
      }
    }

    for (const raw of vacRows) {
      const emp_id = raw.employee_id;
      if (!employeeIds.has(emp_id)) continue;
      const c = cellFor(emp_id, raw.day);
      c.on_vacation = true;
      // Managers and admins are allowed to see the specific absence
      // type — they need it for planning ("X is on sick leave so we
      // can't book that meeting"). For plain employees, collapse to
      // the generic "absence" so health-related types (Krankheit /
      // Sickness, GDPR Art. 9 special category) don't leak across
      // the org. The raw Personio type is the source of truth for
      // managers; employees should ask Personio if they need detail.
      if (c.vacation_type === null) {
        c.vacation_type = isManagerOrAdmin
          ? (raw.time_off_type ?? "absence")
          : "absence";
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
        const planned_entries = c.planned_entries
          .filter((e) => e.hours > 0)
          .sort((a, b) => b.hours - a.hours);
        // Past days: what was actually worked (awork tracked hours);
        // > 1.0 = overtime. Today + future: what is planned (manual
        // allocation + awork Planner); > 1.0 = overbooked. Never both —
        // mixing them flagged "planned on A, worked on B" as 2.0.
        const load_kind = loadKindFor(c.date, today);
        const { load, planned_hours } = computeLoad(
          c.project_load.values(),
          load_kind,
        );
        return {
          employee_id: c.employee_id,
          date: c.date,
          allocation_pct: c.allocation_pct.toFixed(4),
          load: load.toFixed(4),
          load_kind,
          on_vacation: c.on_vacation,
          vacation_type: c.vacation_type,
          assignments: c.assignments,
          // Corner number on the calendar = Personio attendance only.
          // Surface awork's clocked + planned figures separately for
          // tooltip + color logic in the client.
          tracked_hours: personio_h,
          awork_tracked_hours: awork_h,
          tracked_entries,
          planned_hours,
          planned_entries,
          local_public_holiday: c.local_public_holiday,
        };
      });

    return { start, end, days, employees, cells: cell_list };
  });
}
