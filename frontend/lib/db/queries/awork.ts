/** Read-only queries backing the `/api/awork-*` mapping endpoints.
 *
 * The settings/integrations awork page needs four lookup feeds — awork
 * companies / projects / users (with their current mapping status) and
 * the "importable" subset of awork projects whose company is already
 * linked to one of our customers but which isn't yet linked to one of
 * our projects. Each query mirrors the wire shape its route returns;
 * the route stays as a thin auth + param-parse + map shell.
 *
 * The import-side join helper at the bottom backs
 * `lib/actions/awork-import.ts`. The bare-name lookups + link-row
 * writes live with their respective entity (customer.ts / project.ts).
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import { aworkCompanyLink, aworkProject } from "../schema";

export type AworkCompanyRow = {
  awork_company_id: unknown;
  name: unknown;
  is_external: unknown;
  projects_count: unknown;
  projects_in_progress_count: unknown;
  mapped_to_customer_id: unknown;
  mapped_to_customer_name: unknown;
};

export async function listAworkCompanies(opts: {
  mapped: boolean | null;
  q: string | null;
}): Promise<AworkCompanyRow[]> {
  const { mapped, q } = opts;

  const conditions = [sql`1=1`];
  if (mapped === true) {
    conditions.push(sql`link.awork_company_id IS NOT NULL`);
  } else if (mapped === false) {
    conditions.push(sql`link.awork_company_id IS NULL`);
  }
  if (q) {
    const like = `%${q}%`;
    conditions.push(sql`LOWER(aco.name) LIKE LOWER(${like})`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await db.execute(sql`
    SELECT aco.awork_company_id, aco.name, aco.is_external,
           aco.projects_count, aco.projects_in_progress_count,
           link.customer_id, c.name AS our_customer_name
    FROM awork_company aco
    LEFT JOIN awork_company_link link
      ON link.awork_company_id = aco.awork_company_id
    LEFT JOIN customer c ON c.customer_id = link.customer_id
    WHERE ${whereClause}
    ORDER BY aco.projects_count DESC NULLS LAST, aco.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    awork_company_id: row.awork_company_id,
    name: row.name,
    is_external: row.is_external,
    projects_count: row.projects_count,
    projects_in_progress_count: row.projects_in_progress_count,
    mapped_to_customer_id: row.customer_id ?? null,
    mapped_to_customer_name: row.our_customer_name ?? null,
  }));
}

export type AworkProjectRow = {
  awork_project_id: unknown;
  name: unknown;
  project_key: unknown;
  awork_company_id: unknown;
  awork_company_name: unknown;
  is_billable_by_default: unknown;
  is_external: unknown;
  mapped_to_project_id: unknown;
  mapped_to_project_name: unknown;
  mapped_to_customer_name: unknown;
  n_time_entries: number;
};

export async function listAworkProjects(opts: {
  mapped: boolean | null;
  q: string | null;
}): Promise<AworkProjectRow[]> {
  const { mapped, q } = opts;

  const conditions = [sql`1=1`];
  if (mapped === true) {
    conditions.push(sql`link.awork_project_id IS NOT NULL`);
  } else if (mapped === false) {
    conditions.push(sql`link.awork_project_id IS NULL`);
  }
  if (q) {
    const like = `%${q}%`;
    conditions.push(sql`LOWER(ap.name) LIKE LOWER(${like})`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await db.execute(sql`
    SELECT ap.awork_project_id, ap.name, ap.project_key,
           ap.awork_company_id, co.name AS awork_company_name,
           ap.is_billable_by_default, ap.is_external,
           link.project_id, p.name AS our_project, c.name AS customer,
           COALESCE(t.n_entries, 0)::int AS n_entries
    FROM awork_project ap
    LEFT JOIN awork_company co ON co.awork_company_id = ap.awork_company_id
    LEFT JOIN awork_project_link link
      ON link.awork_project_id = ap.awork_project_id
    LEFT JOIN project p ON p.project_id = link.project_id
    LEFT JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN (
      SELECT awork_project_id, COUNT(*) AS n_entries
      FROM awork_time_entry
      WHERE awork_project_id IS NOT NULL
      GROUP BY awork_project_id
    ) t ON t.awork_project_id = ap.awork_project_id
    WHERE ${whereClause}
    ORDER BY COALESCE(t.n_entries, 0) DESC, ap.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    awork_project_id: row.awork_project_id,
    name: row.name,
    project_key: row.project_key,
    awork_company_id: row.awork_company_id,
    awork_company_name: row.awork_company_name ?? null,
    is_billable_by_default: row.is_billable_by_default,
    is_external: row.is_external,
    mapped_to_project_id: row.project_id ?? null,
    mapped_to_project_name: row.our_project ?? null,
    mapped_to_customer_name: row.customer ?? null,
    n_time_entries: Number(row.n_entries ?? 0),
  }));
}

export type AworkProjectImportableRow = {
  awork_project_id: unknown;
  name: unknown;
  project_key: unknown;
  awork_company_id: unknown;
  awork_company_name: unknown;
  start_date: unknown;
  due_date: unknown;
  closed_on: unknown;
  time_budget_hours: number | null;
  project_status_type: unknown;
  project_status_name: unknown;
  description: unknown;
  n_time_entries: number;
  mapped_to_customer_id: unknown;
  mapped_to_customer_name: unknown;
};

export async function listAworkProjectsImportable(opts: {
  customer_id: number | null;
}): Promise<AworkProjectImportableRow[]> {
  const { customer_id } = opts;

  // company linked + not yet mapped to one of our projects
  const conditions = [
    sql`link.customer_id IS NOT NULL`,
    sql`proj_link.project_id IS NULL`,
  ];
  if (customer_id !== null && Number.isInteger(customer_id)) {
    conditions.push(sql`link.customer_id = ${customer_id}`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await db.execute(sql`
    SELECT ap.awork_project_id, ap.name, ap.project_key, ap.awork_company_id,
           aco.name AS awork_company_name,
           ap.start_date, ap.due_date, ap.closed_on,
           ap.time_budget_seconds, ap.project_status_type,
           ap.project_status_name, ap.description,
           COALESCE(t.n_entries, 0)::int AS n_entries,
           link.customer_id, c.name AS customer_name
    FROM awork_project ap
    LEFT JOIN awork_company aco ON aco.awork_company_id = ap.awork_company_id
    LEFT JOIN awork_company_link link
      ON link.awork_company_id = ap.awork_company_id
    LEFT JOIN customer c ON c.customer_id = link.customer_id
    LEFT JOIN awork_project_link proj_link
      ON proj_link.awork_project_id = ap.awork_project_id
    LEFT JOIN (
      SELECT awork_project_id, COUNT(*) AS n_entries
      FROM awork_time_entry
      WHERE awork_project_id IS NOT NULL
      GROUP BY awork_project_id
    ) t ON t.awork_project_id = ap.awork_project_id
    WHERE ${whereClause}
    ORDER BY COALESCE(t.n_entries, 0) DESC, ap.name
  `);

  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    awork_project_id: row.awork_project_id,
    name: row.name,
    project_key: row.project_key,
    awork_company_id: row.awork_company_id,
    awork_company_name: row.awork_company_name ?? null,
    start_date: row.start_date,
    due_date: row.due_date,
    closed_on: row.closed_on,
    // Same int-division as the Python: `seconds // 3600`.
    time_budget_hours:
      row.time_budget_seconds === null || row.time_budget_seconds === undefined
        ? null
        : Math.floor(Number(row.time_budget_seconds) / 3600),
    project_status_type: row.project_status_type,
    project_status_name: row.project_status_name,
    description: row.description,
    n_time_entries: Number(row.n_entries ?? 0),
    mapped_to_customer_id: row.customer_id,
    mapped_to_customer_name: row.customer_name,
  }));
}

export type AworkUserRow = {
  awork_user_id: unknown;
  first_name: unknown;
  last_name: unknown;
  email: unknown;
  position: unknown;
  title: unknown;
  is_archived: unknown;
  is_deactivated: unknown;
  is_external: unknown;
  mapped_to_employee_id: unknown;
  mapped_to_employee_name: unknown;
  n_time_entries: number;
};

export async function listAworkUsers(opts: {
  linked: boolean | null;
  includeArchived: boolean;
}): Promise<AworkUserRow[]> {
  const { linked, includeArchived } = opts;

  const conditions = [sql`1=1`];
  if (!includeArchived) {
    conditions.push(sql`COALESCE(au.is_archived, FALSE) = FALSE`);
  }
  if (linked === true) {
    conditions.push(sql`link.awork_user_id IS NOT NULL`);
  } else if (linked === false) {
    conditions.push(sql`link.awork_user_id IS NULL`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await db.execute(sql`
    SELECT au.awork_user_id, au.first_name, au.last_name, au.email,
           au.position, au.title, au.is_archived, au.is_deactivated,
           au.is_external,
           link.employee_id,
           ec.first_name || ' ' || ec.last_name AS our_name,
           COALESCE(t.n_entries, 0)::int AS n_entries
    FROM awork_user au
    LEFT JOIN awork_user_link link ON link.awork_user_id = au.awork_user_id
    LEFT JOIN employee_current ec ON ec.employee_id = link.employee_id
    LEFT JOIN (
      SELECT awork_user_id, COUNT(*) AS n_entries
      FROM awork_time_entry GROUP BY awork_user_id
    ) t ON t.awork_user_id = au.awork_user_id
    WHERE ${whereClause}
    ORDER BY COALESCE(t.n_entries, 0) DESC, au.last_name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    awork_user_id: row.awork_user_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    position: row.position,
    title: row.title,
    is_archived: row.is_archived,
    is_deactivated: row.is_deactivated,
    is_external: row.is_external,
    mapped_to_employee_id: row.employee_id ?? null,
    mapped_to_employee_name: row.our_name ?? null,
    n_time_entries: Number(row.n_entries ?? 0),
  }));
}

// ----------------------------------------------------------------------------
// Import helpers backing `lib/actions/awork-import.ts`.
//
// The bare-name + link-row writes live with their respective entity:
//   - awork_company_link writes / getAworkCompanyName → `customer.ts`
//   - awork_project_link writes / getAworkProjectName → `project.ts`
//
// This file only carries the multi-table join the import path needs —
// the awork project row plus the company → customer link in one
// round-trip. Splitting it across customer.ts and project.ts would
// force the action to fetch both halves separately.
// ----------------------------------------------------------------------------

export type AworkProjectImportRow = {
  ap_name: string | null;
  ap_company_id: string | null;
  ap_start: string | null;
  ap_due: string | null;
  ap_closed: string | null;
  ap_time_budget_sec: number | null;
  ap_status_type: string | null;
  ap_description: string | null;
  ap_is_billable: boolean | null;
  linked_customer_id: number | null;
};

export async function getAworkProjectImportContext(
  awork_project_id: string,
): Promise<AworkProjectImportRow | null> {
  const [row] = await db
    .select({
      ap_name: aworkProject.name,
      ap_company_id: aworkProject.awork_company_id,
      ap_start: aworkProject.start_date,
      ap_due: aworkProject.due_date,
      ap_closed: aworkProject.closed_on,
      ap_time_budget_sec: aworkProject.time_budget_seconds,
      ap_status_type: aworkProject.project_status_type,
      ap_description: aworkProject.description,
      ap_is_billable: aworkProject.is_billable_by_default,
      linked_customer_id: aworkCompanyLink.customer_id,
    })
    .from(aworkProject)
    .leftJoin(
      aworkCompanyLink,
      eq(aworkCompanyLink.awork_company_id, aworkProject.awork_company_id),
    )
    .where(eq(aworkProject.awork_project_id, awork_project_id));
  return row ?? null;
}
