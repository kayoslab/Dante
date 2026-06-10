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
  aworkProject,
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
