/** Canonical upserts — the only code that writes what adapters pull.
 *
 * Every function takes the integration slug and the sync run id, stamps
 * both onto the rows, and follows one shape:
 *
 *   INSERT ... ON CONFLICT (integration_slug, external_id) DO UPDATE
 *
 * Pruning / archiving of records that vanished upstream is explicit and
 * per capability (see the `prune*` / `archive*` helpers), because each
 * capability has a different safe rule:
 *   - absences: delete unseen rows *inside the synced window* only;
 *   - planned bookings: delete every unseen row (the pull is always full);
 *   - projects: mark unseen rows inactive after a *full* pull that
 *     returned something (a transient empty response must never archive
 *     the whole catalog);
 *   - persons, companies, time entries, compensations: never pruned.
 */
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Client } from "pg";

import {
  absence,
  compensationEvent,
  employeeCurrent,
  externalCompany,
  externalPerson,
  externalProject,
  plannedBooking,
  rawEmployeeSnapshot,
  timeEntry,
} from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";

import type { Capability } from "./capabilities";
import { excludedSet } from "./excluded-set";
import { insertLink, loadLinks } from "./links";
import type {
  CanonicalAbsence,
  CanonicalBooking,
  CanonicalCompany,
  CanonicalCompensation,
  CanonicalEmployee,
  CanonicalPerson,
  CanonicalProject,
  CanonicalTimeEntry,
  DateWindow,
} from "./types";

type EmployeeInsert = typeof employeeCurrent.$inferInsert;

/** The employee_current columns owned by the `people` source. Everything
 *  else on the table (identity, sync stamps) is set here, not by adapters. */
const EMPLOYEE_OWNED_COLUMNS = [
  "first_name",
  "last_name",
  "email",
  "status",
  "department",
  "position",
  "subcompany",
  "office",
  "hire_date",
  "contract_end_date",
  "employment_end_date",
  "employment_type",
  "weekly_working_hours",
  "supervisor_id",
  "fix_salary",
  "fix_salary_interval",
  "hourly_salary",
  "cost_center",
  "gender",
  "probation_period_end",
  "birth_date",
  "nationality",
  "notice_period_probation",
  "absence_entitlement",
] as const;

export type UpsertEmployeesResult = { seen: number; created: number };

/** Materialise the primary `people` source into `employee_current`.
 *
 * Resolution: an existing `('<slug>','person',external_id) → employee`
 * link wins; otherwise a new employee row is created with a generated id
 * and linked. One transaction per employee so a single bad record can't
 * poison the run (same policy as before). Supervisors are resolved
 * through the same links in a second pass, once every employee in the
 * batch has one. */
export async function upsertEmployees(
  conn: Client,
  slug: string,
  sync_run_id: number,
  employees: CanonicalEmployee[],
): Promise<UpsertEmployeesResult> {
  const db = syncDrizzle(conn);
  const now = new Date();
  const links = await loadLinks(conn, slug, "person");
  const idOf = (external_id: string | null): number | null => {
    if (external_id === null) return null;
    const l = links.get(external_id);
    return l && l.dante_type === "employee" ? l.dante_id : null;
  };

  let created = 0;
  const unresolvedSupervisors: Array<{ employee_id: number; supervisor_external_id: string }> = [];

  const updateSet = excludedSet([
    ...EMPLOYEE_OWNED_COLUMNS,
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);

  for (const e of employees) {
    const owned: Omit<EmployeeInsert, "employee_id"> = {
      first_name: e.first_name,
      last_name: e.last_name,
      email: e.email,
      status: e.status,
      department: e.department,
      position: e.position,
      subcompany: e.subcompany,
      office: e.office,
      hire_date: e.hire_date,
      contract_end_date: e.contract_end_date,
      employment_end_date: e.employment_end_date,
      employment_type: e.employment_type,
      weekly_working_hours: e.weekly_working_hours,
      supervisor_id: idOf(e.supervisor_external_id),
      fix_salary: e.fix_salary === null ? null : String(e.fix_salary),
      fix_salary_interval: e.fix_salary_interval,
      hourly_salary: e.hourly_salary === null ? null : String(e.hourly_salary),
      cost_center: e.cost_center,
      gender: e.gender,
      probation_period_end: e.probation_period_end,
      birth_date: e.birth_date,
      nationality: e.nationality,
      notice_period_probation: e.notice_period_probation,
      absence_entitlement: e.absence_entitlement ?? null,
      last_seen_sync_run_id: sync_run_id,
      last_updated_at: now,
    };

    await conn.query("BEGIN");
    try {
      let employee_id = idOf(e.external_id);
      if (employee_id === null) {
        const [ins] = await db
          .insert(employeeCurrent)
          .values(owned)
          .returning({ employee_id: employeeCurrent.employee_id });
        employee_id = ins.employee_id;
        await insertLink(conn, {
          integration_slug: slug,
          entity_type: "person",
          external_id: e.external_id,
          dante_type: "employee",
          dante_id: employee_id,
          origin: "source",
        });
        links.set(e.external_id, { dante_type: "employee", dante_id: employee_id });
        created += 1;
      } else {
        await db
          .insert(employeeCurrent)
          .values({ employee_id, ...owned })
          .onConflictDoUpdate({ target: employeeCurrent.employee_id, set: updateSet });
      }

      await db.insert(rawEmployeeSnapshot).values({
        sync_run_id,
        employee_id,
        payload: (e.raw ?? {}) as Record<string, unknown>,
      });

      // Mirror into external_person so the generic person tooling
      // (link pickers, auto-link) sees HRIS people like any other source.
      await db
        .insert(externalPerson)
        .values({
          integration_slug: slug,
          external_id: e.external_id,
          first_name: e.first_name,
          last_name: e.last_name,
          email: e.email,
          status: e.status,
          is_active: e.status === null ? null : e.status.toLowerCase() === "active",
          is_external: false,
          extra: {},
          source_updated_at: null,
          last_seen_sync_run_id: sync_run_id,
          last_updated_at: now,
        })
        .onConflictDoUpdate({
          target: [externalPerson.integration_slug, externalPerson.external_id],
          set: excludedSet([
            "first_name",
            "last_name",
            "email",
            "status",
            "is_active",
            "is_external",
            "last_seen_sync_run_id",
            "last_updated_at",
          ] as const),
        });

      if (e.supervisor_external_id !== null && owned.supervisor_id === null) {
        unresolvedSupervisors.push({
          employee_id,
          supervisor_external_id: e.supervisor_external_id,
        });
      }
      await conn.query("COMMIT");
    } catch (err) {
      await conn.query("ROLLBACK");
      throw err;
    }
  }

  // Second pass: supervisors that only became resolvable during this batch
  // (a new hire whose manager is also new, or listed later).
  for (const u of unresolvedSupervisors) {
    const sup = idOf(u.supervisor_external_id);
    if (sup === null) continue;
    await db
      .update(employeeCurrent)
      .set({ supervisor_id: sup })
      .where(eq(employeeCurrent.employee_id, u.employee_id));
  }

  return { seen: employees.length, created };
}

export async function upsertPersons(
  conn: Client,
  slug: string,
  sync_run_id: number,
  persons: CanonicalPerson[],
): Promise<number> {
  const db = syncDrizzle(conn);
  const now = new Date();
  const set = excludedSet([
    "first_name",
    "last_name",
    "email",
    "status",
    "is_active",
    "is_external",
    "extra",
    "source_updated_at",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const p of persons) {
    await db
      .insert(externalPerson)
      .values({
        integration_slug: slug,
        external_id: p.external_id,
        first_name: p.first_name,
        last_name: p.last_name,
        email: p.email,
        status: p.status,
        is_active: p.is_active,
        is_external: p.is_external,
        extra: p.extra,
        source_updated_at: p.source_updated_at,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: [externalPerson.integration_slug, externalPerson.external_id],
        set,
      });
  }
  return persons.length;
}

export async function upsertCompanies(
  conn: Client,
  slug: string,
  sync_run_id: number,
  companies: CanonicalCompany[],
): Promise<number> {
  const db = syncDrizzle(conn);
  const now = new Date();
  const set = excludedSet([
    "name",
    "is_external",
    "extra",
    "source_updated_at",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const c of companies) {
    await db
      .insert(externalCompany)
      .values({
        integration_slug: slug,
        external_id: c.external_id,
        name: c.name,
        is_external: c.is_external,
        extra: c.extra,
        source_updated_at: c.source_updated_at,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: [externalCompany.integration_slug, externalCompany.external_id],
        set,
      });
  }
  return companies.length;
}

export async function upsertProjects(
  conn: Client,
  slug: string,
  sync_run_id: number,
  projects: CanonicalProject[],
): Promise<number> {
  const db = syncDrizzle(conn);
  const now = new Date();
  const set = excludedSet([
    "name",
    "project_key",
    "external_company_id",
    "parent_external_id",
    "billable",
    "active",
    "status_type",
    "status_name",
    "start_date",
    "due_date",
    "closed_on",
    "time_budget_seconds",
    "description",
    "extra",
    "source_updated_at",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const p of projects) {
    await db
      .insert(externalProject)
      .values({
        integration_slug: slug,
        external_id: p.external_id,
        name: p.name,
        project_key: p.project_key,
        external_company_id: p.external_company_id,
        parent_external_id: p.parent_external_id,
        billable: p.billable,
        active: p.active,
        status_type: p.status_type,
        status_name: p.status_name,
        start_date: p.start_date,
        due_date: p.due_date,
        closed_on: p.closed_on,
        time_budget_seconds: p.time_budget_seconds,
        description: p.description,
        extra: p.extra,
        source_updated_at: p.source_updated_at,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: [externalProject.integration_slug, externalProject.external_id],
        set,
      });
  }
  return projects.length;
}

/** After a full catalog pull: anything not stamped with this run vanished
 *  upstream (deleted, or hidden from the API). Mark it inactive rather
 *  than deleting, so historical time keeps its project name and the link
 *  pickers just hide it by default. Returns the number archived. */
export async function archiveUnseenProjects(
  conn: Client,
  slug: string,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const rows = await db
    .update(externalProject)
    .set({ active: false, last_updated_at: new Date() })
    .where(
      and(
        eq(externalProject.integration_slug, slug),
        sql`${externalProject.last_seen_sync_run_id} IS DISTINCT FROM ${sync_run_id}`,
        sql`${externalProject.active} IS DISTINCT FROM false`,
      ),
    )
    .returning({ id: externalProject.external_id });
  return rows.length;
}

export type UpsertAbsencesResult = { upserted: number; skipped_unlinked: number; pruned: number };

/** Absences resolve their person through the integration's person links;
 *  an absence for an unlinked person is skipped (nothing to attach it
 *  to). Rows inside the synced window that this run did not refresh no
 *  longer exist upstream (withdrawn, declined, deleted) and are removed —
 *  scoped strictly to the window so a partial sync can never wipe other
 *  date ranges. */
export async function upsertAbsences(
  conn: Client,
  slug: string,
  sync_run_id: number,
  absences: CanonicalAbsence[],
  window: DateWindow,
): Promise<UpsertAbsencesResult> {
  const db = syncDrizzle(conn);
  const links = await loadLinks(conn, slug, "person");
  const set = excludedSet([
    "absence_id",
    "employee_id",
    "time_off_type",
    "start_date",
    "end_date",
    "half_day_start",
    "half_day_end",
    "days_count",
    "status",
    "comment",
    "last_seen_sync_run_id",
  ] as const);
  let upserted = 0;
  let skipped_unlinked = 0;
  for (const a of absences) {
    const link = links.get(a.external_person_id);
    if (!link || link.dante_type !== "employee") {
      skipped_unlinked += 1;
      continue;
    }
    await db
      .insert(absence)
      .values({
        integration_slug: slug,
        external_id: a.external_id,
        absence_id: legacyNumericId(a.external_id),
        employee_id: link.dante_id,
        time_off_type: a.type_name,
        start_date: a.start_date,
        end_date: a.end_date,
        half_day_start: a.half_day_start,
        half_day_end: a.half_day_end,
        days_count: a.days_count,
        status: a.status,
        comment: a.comment,
        last_seen_sync_run_id: sync_run_id,
      })
      .onConflictDoUpdate({
        target: [absence.integration_slug, absence.external_id],
        set,
      });
    upserted += 1;
  }
  const pruned = await db
    .delete(absence)
    .where(
      and(
        eq(absence.integration_slug, slug),
        lt(absence.last_seen_sync_run_id, sync_run_id),
        lte(absence.start_date, window.end_date),
        gte(absence.end_date, window.start_date),
      ),
    )
    .returning({ id: absence.external_id });
  return { upserted, skipped_unlinked, pruned: pruned.length };
}

/** Keep the legacy numeric id column populated where the source id is
 *  numeric (Personio). Purely for readers that still sort or dedupe by
 *  it; retired with the column in phase 5. */
function legacyNumericId(external_id: string): number | null {
  return /^\d{1,15}$/.test(external_id) ? Number(external_id) : null;
}

export type UpsertCompensationsResult = { upserted: number; skipped_unlinked: number };

export async function upsertCompensations(
  conn: Client,
  slug: string,
  sync_run_id: number,
  comps: CanonicalCompensation[],
): Promise<UpsertCompensationsResult> {
  const db = syncDrizzle(conn);
  const now = new Date();
  const links = await loadLinks(conn, slug, "person");
  const set = excludedSet([
    "employee_id",
    "effective_from",
    "amount_value",
    "amount_currency",
    "interval",
    "category",
    "type_name",
    "legal_entity_id",
    "weekly_working_hours",
    "full_time_weekly_working_hours",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  let upserted = 0;
  let skipped_unlinked = 0;
  for (const c of comps) {
    const link = links.get(c.external_person_id);
    if (!link || link.dante_type !== "employee") {
      skipped_unlinked += 1;
      continue;
    }
    await db
      .insert(compensationEvent)
      .values({
        integration_slug: slug,
        compensation_id: c.external_id,
        employee_id: link.dante_id,
        effective_from: c.effective_from,
        amount_value: c.amount_value === null ? null : String(c.amount_value),
        amount_currency: c.amount_currency,
        interval: c.interval,
        category: c.category,
        type_name: c.type_name,
        legal_entity_id: c.legal_entity_id,
        weekly_working_hours: c.weekly_working_hours,
        full_time_weekly_working_hours: c.full_time_weekly_working_hours,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: [compensationEvent.integration_slug, compensationEvent.compensation_id],
        set,
      });
    upserted += 1;
  }
  return { upserted, skipped_unlinked };
}

export async function upsertTimeEntries(
  conn: Client,
  slug: string,
  sync_run_id: number,
  entries: CanonicalTimeEntry[],
): Promise<number> {
  const db = syncDrizzle(conn);
  const set = excludedSet([
    "external_person_id",
    "external_project_id",
    "external_task_id",
    "work_date",
    "start_at",
    "end_at",
    "duration_minutes",
    "is_billable",
    "is_billed",
    "status",
    "note",
    "type_of_work",
    "extra",
    "source_updated_at",
    "last_seen_sync_run_id",
  ] as const);
  for (const t of entries) {
    await db
      .insert(timeEntry)
      .values({
        integration_slug: slug,
        external_id: t.external_id,
        external_person_id: t.external_person_id,
        external_project_id: t.external_project_id,
        external_task_id: t.external_task_id,
        work_date: t.work_date,
        start_at: t.start_at,
        end_at: t.end_at,
        duration_minutes: t.duration_minutes,
        is_billable: t.is_billable,
        is_billed: t.is_billed,
        status: t.status,
        note: t.note,
        type_of_work: t.type_of_work,
        extra: t.extra,
        source_updated_at: t.source_updated_at,
        last_seen_sync_run_id: sync_run_id,
      })
      .onConflictDoUpdate({
        target: [timeEntry.integration_slug, timeEntry.external_id],
        set,
      });
  }
  return entries.length;
}

export type UpsertBookingsResult = { upserted: number; pruned: number };

/** Planner pulls are always complete, so anything not refreshed this run
 *  was deleted upstream and must go — otherwise it survives forever as a
 *  ghost on the calendar. */
export async function upsertPlannedBookings(
  conn: Client,
  slug: string,
  sync_run_id: number,
  bookings: CanonicalBooking[],
): Promise<UpsertBookingsResult> {
  const db = syncDrizzle(conn);
  const set = excludedSet([
    "external_person_id",
    "external_project_id",
    "start_date",
    "end_date",
    "duration_seconds",
    "description",
    "extra",
    "source_created_at",
    "source_updated_at",
    "last_seen_sync_run_id",
  ] as const);
  for (const b of bookings) {
    await db
      .insert(plannedBooking)
      .values({
        integration_slug: slug,
        external_id: b.external_id,
        external_person_id: b.external_person_id,
        external_project_id: b.external_project_id,
        start_date: b.start_date,
        end_date: b.end_date,
        duration_seconds: b.duration_seconds,
        description: b.description,
        extra: b.extra,
        source_created_at: b.source_created_at,
        source_updated_at: b.source_updated_at,
        last_seen_sync_run_id: sync_run_id,
      })
      .onConflictDoUpdate({
        target: [plannedBooking.integration_slug, plannedBooking.external_id],
        set,
      });
  }
  const pruned = await db
    .delete(plannedBooking)
    .where(
      and(
        eq(plannedBooking.integration_slug, slug),
        sql`${plannedBooking.last_seen_sync_run_id} <> ${sync_run_id}`,
      ),
    )
    .returning({ id: plannedBooking.external_id });
  return { upserted: bookings.length, pruned: pruned.length };
}

/** Newest `source_updated_at` stored for (integration, capability) — the
 *  delta high-water mark adapters ask for through `PullContext`. */
export async function highWaterMark(
  conn: Client,
  slug: string,
  capability: Capability,
): Promise<Date | null> {
  const table = HWM_TABLE[capability];
  if (!table) return null;
  const r = await conn.query<{ max: Date | null }>(
    `SELECT MAX(source_updated_at) AS max FROM ${table} WHERE integration_slug = $1`,
    [slug],
  );
  const max = r.rows[0]?.max ?? null;
  return max ? new Date(max) : null;
}

const HWM_TABLE: Partial<Record<Capability, string>> = {
  external_contributors: "external_person",
  companies: "external_company",
  projects: "external_project",
  time_entries: "time_entry",
  planned_bookings: "planned_booking",
};
