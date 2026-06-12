/** Sync awork.com data into Postgres.
 *
 * Read-only on the awork side — every API call goes through `aworkClient`
 * which is GET-only at the transport layer.
 *
 * Resources synced:
 *   /companies   → awork_company
 *   /users       → awork_user
 *   /projects    → awork_project (+ resolved Daily Rate / Fixed Price /
 *                  Order Number custom fields)
 *   /timeentries → awork_time_entry (paginated by date range)
 *
 * Post-sync auto-link:
 *   awork_company.name == customer.name (case-insensitive) → awork_company_link
 *   awork_user.email   == employee_current.email           → awork_user_link
 */
import type { Client } from "pg";

import {
  aworkCompany,
  aworkCompanyLink,
  aworkFreelancerLink,
  aworkProject,
  aworkTimeBooking,
  aworkTimeEntry,
  aworkUser,
  aworkUserLink,
} from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { AworkClient } from "./client";
import { aworkUserStatus } from "./schemas";
import type { AworkCustomFieldValue, AworkProject } from "./schemas";

function dateOnly(iso: unknown): string | null {
  if (!iso) return null;
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function toDate(iso: unknown): Date | null {
  if (!iso) return null;
  const d = new Date(String(iso));
  return isNaN(d.getTime()) ? null : d;
}

function emailFromContactInfos(
  infos:
    | Array<{ type?: string | null; subType?: string | null; value?: string | null }>
    | null
    | undefined,
): string | null {
  if (!infos) return null;
  const workEmail = infos.find(
    (c) => c.type === "email" && c.subType === "work",
  )?.value;
  if (workEmail) return workEmail;
  return infos.find((c) => c.type === "email")?.value ?? null;
}

export async function syncAworkCompanies(
  conn: Client,
  client: AworkClient,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listClients();
  const now = new Date();
  const set = excludedSet([
    "name",
    "is_external",
    "projects_count",
    "projects_in_progress_count",
    "created_on",
    "updated_on",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const item of items) {
    await db
      .insert(aworkCompany)
      .values({
        awork_company_id: item.id,
        name: item.name ?? null,
        is_external: item.isExternal ?? null,
        projects_count: item.projectsCount ?? null,
        projects_in_progress_count: item.projectsInProgressCount ?? null,
        created_on: toDate(item.createdOn),
        updated_on: toDate(item.updatedOn),
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: aworkCompany.awork_company_id,
        set,
      });
  }
  return items.length;
}

export async function syncAworkUsers(
  conn: Client,
  client: AworkClient,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listUsers();
  const now = new Date();
  const set = excludedSet([
    "first_name",
    "last_name",
    "email",
    "position",
    "title",
    "is_agent",
    "is_archived",
    "is_deactivated",
    "is_external",
    "status",
    "created_on",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const item of items) {
    const email = emailFromContactInfos(item.userContactInfos);
    await db
      .insert(aworkUser)
      .values({
        awork_user_id: item.id,
        first_name: item.firstName ?? null,
        last_name: item.lastName ?? null,
        email,
        position: item.position ?? null,
        title: item.title ?? null,
        is_agent: item.isAgent ?? null,
        is_archived: item.isArchived ?? null,
        is_deactivated: item.isDeactivated ?? null,
        is_external: item.isExternal ?? null,
        status: aworkUserStatus(item.status),
        created_on: toDate(item.createdOn),
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: aworkUser.awork_user_id,
        set,
      });
  }
  return items.length;
}

type MoneyFieldIds = {
  daily_rate: string | null;
  fixed_price: string | null;
  order_number: string | null;
};

async function resolveMoneyFieldIds(
  client: AworkClient,
): Promise<MoneyFieldIds> {
  const defs = await client.listCustomFieldDefinitions();
  const byName = new Map<string, string>();
  for (const d of defs) {
    if (d.name) byName.set(d.name, d.id);
  }
  return {
    daily_rate: byName.get("Daily Rate") ?? null,
    fixed_price: byName.get("Fixed Price") ?? null,
    order_number: byName.get("Order Number") ?? null,
  };
}

function extractCustomFieldValues(
  item: AworkProject,
  ids: MoneyFieldIds,
): { daily_rate: number | null; fixed_price: number | null; order_number: string | null } {
  if (!item.customFields) {
    return { daily_rate: null, fixed_price: null, order_number: null };
  }
  const byId = new Map<string, AworkCustomFieldValue>();
  for (const cf of item.customFields) {
    if (cf.customFieldDefinitionId) byId.set(cf.customFieldDefinitionId, cf);
  }
  const num = (id: string | null): number | null => {
    if (!id) return null;
    const cf = byId.get(id);
    if (!cf || cf.numberValue === null || cf.numberValue === undefined) return null;
    return Number.isFinite(cf.numberValue) ? cf.numberValue : null;
  };
  const text = (id: string | null): string | null => {
    if (!id) return null;
    const cf = byId.get(id);
    return cf?.textValue ?? cf?.stringValue ?? null;
  };
  return {
    daily_rate: num(ids.daily_rate),
    fixed_price: num(ids.fixed_price),
    order_number: text(ids.order_number),
  };
}

export async function syncAworkProjects(
  conn: Client,
  client: AworkClient,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listProjects();
  const now = new Date();
  let fieldIds: MoneyFieldIds;
  try {
    fieldIds = await resolveMoneyFieldIds(client);
  } catch {
    fieldIds = { daily_rate: null, fixed_price: null, order_number: null };
  }
  const set = excludedSet([
    "name",
    "project_key",
    "awork_company_id",
    "is_billable_by_default",
    "is_external",
    "is_private",
    "is_retainer",
    "project_status_id",
    "description",
    "tasks_count",
    "tasks_done_count",
    "created_on",
    "updated_on",
    "last_seen_sync_run_id",
    "last_updated_at",
    "start_date",
    "due_date",
    "closed_on",
    "time_budget_seconds",
    "project_status_type",
    "project_status_name",
    "daily_rate_eur",
    "fixed_price_eur",
    "order_number",
  ] as const);
  for (const item of items) {
    const money = extractCustomFieldValues(item, fieldIds);
    const projectInsert: typeof aworkProject.$inferInsert = {
      awork_project_id: item.id,
      name: item.name ?? null,
      project_key: item.projectKey ?? null,
      awork_company_id: item.companyId ?? null,
      is_billable_by_default: item.isBillableByDefault ?? null,
      is_external: item.isExternal ?? null,
      is_private: item.isPrivate ?? null,
      is_retainer: item.isRetainer ?? null,
      project_status_id: item.projectStatusId ?? null,
      description: item.description ?? null,
      tasks_count: item.tasksCount ?? null,
      tasks_done_count: item.tasksDoneCount ?? null,
      created_on: toDate(item.createdOn),
      updated_on: toDate(item.updatedOn),
      last_seen_sync_run_id: sync_run_id,
      last_updated_at: now,
      start_date: dateOnly(item.startDate),
      due_date: dateOnly(item.dueDate),
      closed_on: dateOnly(item.closedOn),
      time_budget_seconds: item.timeBudget ?? null,
      project_status_type: item.projectStatus?.type ?? null,
      project_status_name: item.projectStatus?.name ?? null,
      daily_rate_eur: money.daily_rate !== null ? String(money.daily_rate) : null,
      fixed_price_eur:
        money.fixed_price !== null ? String(money.fixed_price) : null,
      order_number: money.order_number,
    };
    await db
      .insert(aworkProject)
      .values(projectInsert)
      .onConflictDoUpdate({
        target: aworkProject.awork_project_id,
        set,
      });
  }
  return items.length;
}

export async function syncAworkTimeEntries(
  conn: Client,
  client: AworkClient,
  sync_run_id: number,
  start_date: string,
  end_date: string,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listTimeEntries({ start_date, end_date });
  const set = excludedSet([
    "awork_user_id",
    "awork_project_id",
    "awork_task_id",
    "work_date",
    "duration_seconds",
    "duration_minutes",
    "is_billable",
    "is_billed",
    "note",
    "type_of_work_id",
    "type_of_work_name",
    "start_date_utc",
    "end_date_utc",
    "last_seen_sync_run_id",
  ] as const);
  for (const item of items) {
    const duration_seconds = item.duration ?? 0;
    const duration_minutes = Math.floor(duration_seconds / 60);
    await db
      .insert(aworkTimeEntry)
      .values({
        awork_time_entry_id: item.id,
        awork_user_id: item.userId ?? null,
        awork_project_id: item.projectId ?? null,
        awork_task_id: item.taskId ?? null,
        work_date: dateOnly(item.startDateLocal ?? item.startDateUtc),
        duration_seconds,
        duration_minutes,
        is_billable: item.isBillable ?? null,
        is_billed: item.isBilled ?? null,
        note: item.note ?? null,
        type_of_work_id: item.typeOfWork?.id ?? null,
        type_of_work_name: item.typeOfWork?.name ?? null,
        start_date_utc: toDate(item.startDateUtc),
        end_date_utc: toDate(item.endDateUtc),
        last_seen_sync_run_id: sync_run_id,
      })
      .onConflictDoUpdate({
        target: aworkTimeEntry.awork_time_entry_id,
        set,
      });
  }
  return items.length;
}

/** Sync awork "time bookings" — the entries rendered on awork's Planner.
 * The endpoint is unfiltered (no date window arg), so we pull the full
 * list every run. After the upsert, prune rows that weren't refreshed
 * — awork dropped them (PM edited the Planner) and the row would
 * otherwise survive forever as a ghost on the calendar.
 *
 * Returns the count of rows seen + the count of stale rows pruned. */
export async function syncAworkTimeBookings(
  conn: Client,
  client: AworkClient,
  sync_run_id: number,
): Promise<{ upserted: number; pruned: number }> {
  const db = syncDrizzle(conn);
  const items = await client.listTimeBookings();
  const set = excludedSet([
    "awork_user_id",
    "awork_project_id",
    "start_date",
    "end_date",
    "duration_seconds",
    "lane_order",
    "description",
    "created_on",
    "updated_on",
    "last_seen_sync_run_id",
  ] as const);
  // awork's Planner also stores absence-style bookings (vacation,
  // training, etc.) with no project. Personio's absence feed already
  // covers those, so drop them here rather than carrying nulls through
  // the schema.
  let upserted = 0;
  for (const item of items) {
    if (!item.projectId) continue;
    await db
      .insert(aworkTimeBooking)
      .values({
        awork_time_booking_id: item.id,
        awork_user_id: item.userId,
        awork_project_id: item.projectId,
        start_date: item.startDate,
        end_date: item.endDate,
        duration_seconds: item.duration,
        lane_order: item.laneOrder ?? null,
        description: item.description ?? null,
        created_on: toDate(item.createdOn),
        updated_on: toDate(item.updatedOn),
        last_seen_sync_run_id: sync_run_id,
      })
      .onConflictDoUpdate({
        target: aworkTimeBooking.awork_time_booking_id,
        set,
      });
    upserted += 1;
  }
  // Stale-row cleanup. Anything not refreshed this run was deleted from
  // the Planner upstream; remove it so the calendar matches.
  const pruned = await conn.query<{ id: string }>(
    `DELETE FROM awork_time_booking
       WHERE last_seen_sync_run_id <> $1
       RETURNING awork_time_booking_id AS id`,
    [sync_run_id],
  );
  return { upserted, pruned: pruned.rows.length };
}

/** Roll up `awork_time_booking` rows into `assignment` rows so the home
 * dashboard, project economics, and the calendar's allocation signal
 * all have something to work with. Wipes existing
 * `source = 'awork-planning'` rows and re-inserts from scratch — the
 * Planner is the source of truth and we want the table to match it
 * exactly. Manual rows (source = 'manual') are left alone.
 *
 * Allocation math:
 *   total_seconds / (weekdays_in_range × 8h × 3600s/h)
 *
 * Capped at 1.5 to honor the existing `allocation_pct ≤ 1.5` convention;
 * two overlapping bookings against the same person on the same project
 * (unusual but possible) get summed into a single 1.5-capped row.
 *
 * Orphaned bookings (awork user / project not linked into Dante) are
 * skipped silently — they'll start materializing once the auto-linker
 * picks them up. */
export async function rollupAworkPlanningsToAssignments(
  conn: Client,
): Promise<{
  deleted_previous: number;
  inserted: number;
  skipped_unlinked_user: number;
  skipped_unlinked_project: number;
}> {
  const deleted = await conn.query(
    `DELETE FROM assignment WHERE source = 'awork-planning'`,
  );
  // Group bookings by the AWORK keys (not the Dante keys) so an
  // unmapped (user, project) bucket counts as one — grouping by the
  // resolved IDs would collapse every unmapped pair into a single
  // (NULL, NULL) row and the skip counters would lie.
  //
  // Each (awork_user, awork_project) pair becomes one assignment row.
  // Routing: prefer the employee link; fall back to freelancer link
  // (matches the rest of the awork sync — multi-org Dante employees
  // are the primary case, freelancers a secondary one).
  const rows = await conn.query<{
    awork_user_id: string;
    awork_project_id: string;
    employee_id: number | null;
    freelancer_id: number | null;
    project_id: number | null;
    start_date: string;
    end_date: string;
    total_seconds: string;
  }>(`
    SELECT
      tb.awork_user_id,
      tb.awork_project_id,
      ul.employee_id,
      fl.freelancer_id,
      pl.project_id,
      MIN(tb.start_date)::text AS start_date,
      MAX(tb.end_date)::text   AS end_date,
      SUM(tb.duration_seconds)::text AS total_seconds
    FROM awork_time_booking tb
    LEFT JOIN awork_user_link ul ON ul.awork_user_id = tb.awork_user_id
    LEFT JOIN awork_freelancer_link fl ON fl.awork_user_id = tb.awork_user_id
    LEFT JOIN awork_project_link pl ON pl.awork_project_id = tb.awork_project_id
    GROUP BY tb.awork_user_id, tb.awork_project_id,
             ul.employee_id, fl.freelancer_id, pl.project_id
  `);

  const now = new Date();
  let inserted = 0;
  let skipped_unlinked_user = 0;
  let skipped_unlinked_project = 0;

  for (const r of rows.rows) {
    const has_employee = r.employee_id !== null;
    const has_freelancer = r.freelancer_id !== null;
    if (!has_employee && !has_freelancer) {
      skipped_unlinked_user += 1;
      continue;
    }
    if (r.project_id === null) {
      skipped_unlinked_project += 1;
      continue;
    }
    // Working days in [start, end] (weekends excluded). At least 1 so
    // a single-day booking still divides cleanly.
    const wd = await conn.query<{ wd: string }>(
      `
      SELECT COUNT(*)::text AS wd
      FROM generate_series($1::date, $2::date, '1 day'::interval) d
      WHERE EXTRACT(DOW FROM d) NOT IN (0, 6)
    `,
      [r.start_date, r.end_date],
    );
    const workdays = Math.max(Number(wd.rows[0]?.wd ?? 0), 1);
    const totalSeconds = Number(r.total_seconds);
    const rawAlloc = totalSeconds / (workdays * 8 * 3600);
    const alloc = Math.min(rawAlloc, 1.5);

    await conn.query(
      `
      INSERT INTO assignment
        (employee_id, freelancer_id, project_id, profile, allocation_pct,
         start_date, end_date, notes, source, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awork-planning', $9, $9)
    `,
      [
        has_employee ? r.employee_id : null,
        has_employee ? null : r.freelancer_id,
        r.project_id,
        null,
        alloc.toFixed(4),
        r.start_date,
        r.end_date,
        "Synced from awork Planner; edit there to change.",
        now,
      ],
    );
    inserted += 1;
  }

  return {
    deleted_previous: deleted.rowCount ?? 0,
    inserted,
    skipped_unlinked_user,
    skipped_unlinked_project,
  };
}

export async function autoLinkAworkUsersByEmail(
  conn: Client,
): Promise<{ new_links: number; total: number }> {
  const now = new Date();
  const rows = await conn.query<{
    awork_user_id: string;
    employee_id: number;
  }>(`
    SELECT au.awork_user_id, ec.employee_id
    FROM awork_user au
    JOIN employee_current ec ON LOWER(ec.email) = LOWER(au.email)
    LEFT JOIN awork_user_link link ON link.awork_user_id = au.awork_user_id
    WHERE link.awork_user_id IS NULL
  `);
  const db = syncDrizzle(conn);
  for (const r of rows.rows) {
    await db
      .insert(aworkUserLink)
      .values({
        awork_user_id: r.awork_user_id,
        employee_id: r.employee_id,
        mapped_at: now,
      })
      .onConflictDoNothing();
  }
  const total = await conn.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM awork_user_link",
  );
  return { new_links: rows.rows.length, total: Number(total.rows[0].count) };
}

export async function autoLinkAworkCompaniesByName(
  conn: Client,
): Promise<{ new_links: number; total: number }> {
  const now = new Date();
  const rows = await conn.query<{
    awork_company_id: string;
    customer_id: number;
  }>(`
    SELECT aco.awork_company_id, c.customer_id
    FROM awork_company aco
    JOIN customer c ON LOWER(c.name) = LOWER(aco.name)
    LEFT JOIN awork_company_link link ON link.awork_company_id = aco.awork_company_id
    WHERE link.awork_company_id IS NULL
  `);
  const db = syncDrizzle(conn);
  for (const r of rows.rows) {
    await db
      .insert(aworkCompanyLink)
      .values({
        awork_company_id: r.awork_company_id,
        customer_id: r.customer_id,
        mapped_at: now,
      })
      .onConflictDoNothing();
  }
  const total = await conn.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM awork_company_link",
  );
  return { new_links: rows.rows.length, total: Number(total.rows[0].count) };
}

/** Auto-link awork users to freelancers by email (case-insensitive).
 *
 * Sister to `autoLinkAworkUsersByEmail` — same shape but targets the
 * freelancer table. An awork user matches at most one of (employee,
 * freelancer) so a row appearing in both link tables is a data error
 * worth investigating (operator's email collision). */
export async function autoLinkAworkFreelancersByEmail(
  conn: Client,
): Promise<{ new_links: number; total: number }> {
  const now = new Date();
  const rows = await conn.query<{
    awork_user_id: string;
    freelancer_id: number;
  }>(`
    SELECT au.awork_user_id, f.freelancer_id
    FROM awork_user au
    JOIN freelancer f ON LOWER(f.contact_email) = LOWER(au.email)
    LEFT JOIN awork_freelancer_link link ON link.awork_user_id = au.awork_user_id
    WHERE link.awork_user_id IS NULL
      AND au.email IS NOT NULL
      AND f.contact_email IS NOT NULL
  `);
  const db = syncDrizzle(conn);
  for (const r of rows.rows) {
    await db
      .insert(aworkFreelancerLink)
      .values({
        awork_user_id: r.awork_user_id,
        freelancer_id: r.freelancer_id,
        mapped_at: now,
      })
      .onConflictDoNothing();
  }
  const total = await conn.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM awork_freelancer_link",
  );
  return { new_links: rows.rows.length, total: Number(total.rows[0].count) };
}

/** Roll up awork time entries into `freelancer_time_entry` rows.
 *
 * Per (assignment, year_month) — where the assignment is the freelancer
 * assignment that matches both the linked freelancer (via
 * `awork_freelancer_link`) and the linked project (via
 * `awork_project_link`) on the entry's `work_date`.
 *
 * Conflict rule (must match the comment in `setFreelancerHoursAction`):
 *   manual rows always win — we UPSERT with `source='awork'` and only
 *   overwrite the value when the existing row's source is also 'awork'.
 *
 * Returns `{ rows_upserted }` so the caller can log how much hours data
 * the rollup wrote in this run.
 *
 * Performance: one aggregate query + per-row UPSERT. For a 40-person
 * org with maybe 3-5 active freelancers this is fine (<100 rows/run).
 * If freelancer count grows we'd switch to a single INSERT … SELECT. */
export async function rollupAworkHoursToFreelancers(
  conn: Client,
): Promise<{ rows_upserted: number }> {
  const rows = await conn.query<{
    assignment_id: number;
    year_month: string;
    hours_decimal: string;
  }>(`
    SELECT
      a.assignment_id,
      to_char(t.work_date, 'YYYY-MM') AS year_month,
      ROUND(SUM(t.duration_minutes)::numeric / 60, 2)::text AS hours_decimal
    FROM awork_time_entry t
    JOIN awork_freelancer_link fl
      ON fl.awork_user_id = t.awork_user_id
    JOIN awork_project_link pl
      ON pl.awork_project_id = t.awork_project_id
    JOIN assignment a
      ON a.project_id = pl.project_id
      AND a.freelancer_id = fl.freelancer_id
      AND t.work_date >= a.start_date
      AND (a.end_date IS NULL OR t.work_date <= a.end_date)
    WHERE t.duration_minutes IS NOT NULL
    GROUP BY a.assignment_id, to_char(t.work_date, 'YYYY-MM')
  `);

  let upserts = 0;
  for (const r of rows.rows) {
    // Manual rows win — only update when the existing row is awork-sourced
    // (or no row yet). The WHERE on the DO UPDATE clause enforces this.
    const result = await conn.query(
      `
      INSERT INTO freelancer_time_entry
        (assignment_id, year_month, hours_decimal, source, entered_at)
      VALUES ($1, $2, $3, 'awork', now())
      ON CONFLICT (assignment_id, year_month) DO UPDATE
        SET hours_decimal = EXCLUDED.hours_decimal,
            entered_at = now()
        WHERE freelancer_time_entry.source = 'awork'
      `,
      [r.assignment_id, r.year_month, r.hours_decimal],
    );
    if (result.rowCount && result.rowCount > 0) upserts += 1;
  }
  return { rows_upserted: upserts };
}
