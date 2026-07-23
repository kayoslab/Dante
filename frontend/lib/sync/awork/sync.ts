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
import { germanFederalHolidays } from "@/lib/db/_de-holidays";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";
import { log } from "@/lib/logger";

import type { AworkClient } from "./client";
import { aworkUserStatus } from "./schemas";
import type { AworkCustomFieldValue, AworkProject } from "./schemas";

/** Result of a catalog pull: how many rows came back and whether the run
 * was a delta (`incremental`) or a `full` scan. Surfaced so the sync log
 * makes the mode visible per run. */
type PullMode = "full" | "incremental";
export type AworkPullResult = { count: number; mode: PullMode };

/** High-water mark for an awork catalog table: the newest `updated_on`
 * we've already stored, formatted as a bare OData datetime literal body
 * (`YYYY-MM-DDTHH:MM:SS`, no ms / no `Z`) for awork's `filterby`. Returns
 * null when the table is empty or every row's `updated_on` is null — the
 * caller then falls back to a full pull.
 *
 * `table` is a fixed internal literal (typed union), never user input, so
 * interpolating it is safe. Raw `conn.query` here matches this file's
 * existing usage — `lib/sync` is the data-ingest tier and is exempt from
 * the db-locality rule (see `scripts/check-db-locality.ts`). */
async function aworkMaxUpdatedOn(
  conn: Client,
  table: "awork_company" | "awork_project",
): Promise<string | null> {
  const r = await conn.query<{ max: Date | null }>(
    `SELECT MAX(updated_on) AS max FROM ${table}`,
  );
  const max = r.rows[0]?.max ?? null;
  if (!max) return null;
  return new Date(max).toISOString().replace(/\.\d{3}Z$/, "");
}

/** Pull a full-scan awork catalog either incrementally (only rows whose
 * `updatedOn` is at/after our high-water mark) or in full. Falls back to
 * a full pull when there is no watermark yet (first run / empty table) or
 * when awork rejects the delta filter — so an unsupported `filterby` on a
 * given endpoint degrades to a correct (if slower) full sync, logged,
 * rather than throwing and aborting the whole awork run.
 *
 * Only safe for pure-upsert catalogs (companies, projects). Do NOT use
 * for `time_bookings`, whose stale-row prune keys off
 * `last_seen_sync_run_id` — a delta pull would prune every unchanged row. */
async function pullAworkCatalog<T>(
  conn: Client,
  table: "awork_company" | "awork_project",
  resource: string,
  full: boolean,
  list: (opts?: { updated_since?: string | null }) => Promise<T[]>,
): Promise<{ items: T[]; mode: PullMode }> {
  if (!full) {
    const updated_since = await aworkMaxUpdatedOn(conn, table);
    if (updated_since) {
      try {
        return { items: await list({ updated_since }), mode: "incremental" };
      } catch (e) {
        log.warn("awork_delta_fallback", {
          resource,
          issue: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return { items: await list(), mode: "full" };
}

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
  full = false,
): Promise<AworkPullResult> {
  const db = syncDrizzle(conn);
  const { items, mode } = await pullAworkCatalog(
    conn,
    "awork_company",
    "company",
    full,
    (o) => client.listClients(o),
  );
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
  return { count: items.length, mode };
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
  full = false,
): Promise<AworkPullResult> {
  const db = syncDrizzle(conn);
  const { items, mode } = await pullAworkCatalog(
    conn,
    "awork_project",
    "project",
    full,
    (o) => client.listProjects(o),
  );
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
  return { count: items.length, mode };
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
// Holiday-aware working days for the Planner rollup. German federal holidays
// only (bookings carry no office/state); cached per year range. Pure — no DB.
const plannerHolidayCache = new Map<string, Map<string, string>>();
function plannerWorkdays(start: string, end: string): string[] {
  const yKey = `${start.slice(0, 4)}-${end.slice(0, 4)}`;
  let holidays = plannerHolidayCache.get(yKey);
  if (holidays === undefined) {
    holidays = germanFederalHolidays(
      Number(start.slice(0, 4)),
      Number(end.slice(0, 4)),
    );
    plannerHolidayCache.set(yKey, holidays);
  }
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (cur <= stop) {
    const iso = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(iso)) out.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

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
  // Raw bookings with their link resolution. Routing: prefer the employee
  // link; fall back to freelancer link (matches the rest of the awork sync).
  //
  // Bookings are bucketed per (user, project, MONTH) rather than collapsed
  // into one MIN–MAX span per (user, project): the old single-span rollup
  // smeared lumpy plans evenly across their whole range (one week in June +
  // one week in August became a thin June–August film), distorting every
  // month's planned hours. Per-month buckets keep each month's planned load
  // where the Planner actually put it.
  const rows = await conn.query<{
    awork_user_id: string;
    awork_project_id: string;
    employee_id: number | null;
    freelancer_id: number | null;
    project_id: number | null;
    start_date: string;
    end_date: string;
    duration_seconds: string;
  }>(`
    SELECT
      tb.awork_user_id,
      tb.awork_project_id,
      ul.employee_id,
      fl.freelancer_id,
      pl.project_id,
      tb.start_date::text AS start_date,
      tb.end_date::text   AS end_date,
      tb.duration_seconds::text AS duration_seconds
    FROM awork_time_booking tb
    LEFT JOIN awork_user_link ul ON ul.awork_user_id = tb.awork_user_id
    LEFT JOIN awork_freelancer_link fl ON fl.awork_user_id = tb.awork_user_id
    LEFT JOIN awork_project_link pl ON pl.awork_project_id = tb.awork_project_id
  `);

  const now = new Date();
  let inserted = 0;
  // Skip counters stay per distinct (user, project) pair — the unit the old
  // grouped rollup counted — so the log numbers keep their meaning.
  const skippedUserPairs = new Set<string>();
  const skippedProjectPairs = new Set<string>();

  // Bucket: one planned-assignment row per (entity, project, month).
  type Bucket = {
    employee_id: number | null;
    freelancer_id: number | null;
    project_id: number;
    min_day: string;
    max_day: string;
    seconds: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const r of rows.rows) {
    const pairKey = `${r.awork_user_id}|${r.awork_project_id}`;
    const has_employee = r.employee_id !== null;
    const has_freelancer = r.freelancer_id !== null;
    if (!has_employee && !has_freelancer) {
      skippedUserPairs.add(pairKey);
      continue;
    }
    if (r.project_id === null) {
      skippedProjectPairs.add(pairKey);
      continue;
    }
    // Holiday-aware working days of the booking span (the old SQL count was
    // weekday-only, silently counting German holidays as plannable days).
    // A booking with no working day at all (weekend/holiday-only span) keeps
    // its hours on the start day rather than vanishing.
    const days = plannerWorkdays(r.start_date, r.end_date);
    const spreadDays = days.length > 0 ? days : [r.start_date];
    const perDay = Number(r.duration_seconds) / spreadDays.length;
    for (const day of spreadDays) {
      const month = day.slice(0, 7);
      const key = `${has_employee ? "e" + r.employee_id : "f" + r.freelancer_id}|${r.project_id}|${month}`;
      const b = buckets.get(key);
      if (b === undefined) {
        buckets.set(key, {
          employee_id: has_employee ? r.employee_id : null,
          freelancer_id: has_employee ? null : r.freelancer_id,
          project_id: r.project_id,
          min_day: day,
          max_day: day,
          seconds: perDay,
        });
      } else {
        if (day < b.min_day) b.min_day = day;
        if (day > b.max_day) b.max_day = day;
        b.seconds += perDay;
      }
    }
  }

  for (const b of buckets.values()) {
    // Allocation over the bucket's own span: consumers integrate
    // `alloc × working days in span`, so seconds ÷ (span workdays × 8h)
    // reproduces the booked hours exactly (up to the 1.5 sanity cap).
    const spanWd = Math.max(plannerWorkdays(b.min_day, b.max_day).length, 1);
    const rawAlloc = b.seconds / (spanWd * 8 * 3600);
    const alloc = Math.min(rawAlloc, 1.5);

    await conn.query(
      `
      INSERT INTO assignment
        (employee_id, freelancer_id, project_id, profile, allocation_pct,
         start_date, end_date, notes, source, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awork-planning', $9, $9)
    `,
      [
        b.employee_id,
        b.freelancer_id,
        b.project_id,
        // Set profile = 'default' rather than NULL. awork doesn't have a
        // role-tier concept on its bookings, but every Dante rate sheet
        // currently entered for an awork-linked project uses the single
        // 'default' profile name — leaving NULL forces the rate resolver
        // to fall through to the employee's role_tier (junior / senior /
        // advanced), which doesn't match 'default' and revenue resolves
        // to 0 even with tracked time + a rate. Setting 'default' here
        // makes synced rows match the rate sheet by construction.
        "default",
        alloc.toFixed(4),
        b.min_day,
        b.max_day,
        "Synced from awork Planner; edit there to change.",
        now,
      ],
    );
    inserted += 1;
  }
  const skipped_unlinked_user = skippedUserPairs.size;
  const skipped_unlinked_project = skippedProjectPairs.size;

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
