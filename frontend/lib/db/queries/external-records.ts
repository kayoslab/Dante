/** External records and links — the generic replacement for the awork /
 * Personio pickers and link tables.
 *
 * A record is a row in external_person / external_company /
 * external_project, addressed by (integration, entity type, external id).
 * A link maps one of them to a Dante entity. This module backs
 * `/api/integrations/[slug]/records`, `/api/links`, the link card, and the
 * import + link server actions, for any integration alike. */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { externalLink } from "../schema";
import type { DanteEntityType, ExternalEntityType } from "@/lib/integrations/core/capabilities";

export type MappedTo = {
  dante_type: DanteEntityType;
  dante_id: number;
  name: string | null;
  /** For projects: the owning customer's name. */
  customer_name: string | null;
};

export type ExternalRecordRow = {
  integration_slug: string;
  entity_type: ExternalEntityType;
  external_id: string;
  name: string | null;
  /** Person: e-mail. Project: company name. Company: null. */
  secondary: string | null;
  active: boolean | null;
  is_external: boolean | null;
  /** Projects: the source's own billability flag. */
  billable: boolean | null;
  parent_external_id: string | null;
  parent_name: string | null;
  mapped_to: MappedTo | null;
  /** Persons / projects: time entries referencing the record. Companies:
   *  projects under the company. */
  n_entries: number;
  // Project details used by the import flow.
  start_date: string | null;
  due_date: string | null;
  closed_on: string | null;
  time_budget_hours: number | null;
  status_type: string | null;
  status_name: string | null;
  description: string | null;
};

type Raw = Record<string, unknown>;

function mappedTo(row: Raw): MappedTo | null {
  if (row.dante_id === null || row.dante_id === undefined) return null;
  return {
    dante_type: row.dante_type as DanteEntityType,
    dante_id: Number(row.dante_id),
    name: (row.mapped_name as string | null) ?? null,
    customer_name: (row.mapped_customer_name as string | null) ?? null,
  };
}

function toRow(entity_type: ExternalEntityType, row: Raw): ExternalRecordRow {
  return {
    integration_slug: row.integration_slug as string,
    entity_type,
    external_id: String(row.external_id),
    name: (row.name as string | null) ?? null,
    secondary: (row.secondary as string | null) ?? null,
    active: (row.active as boolean | null) ?? null,
    is_external: (row.is_external as boolean | null) ?? null,
    billable: (row.billable as boolean | null) ?? null,
    parent_external_id: (row.parent_external_id as string | null) ?? null,
    parent_name: (row.parent_name as string | null) ?? null,
    mapped_to: mappedTo(row),
    n_entries: Number(row.n_entries ?? 0),
    start_date: (row.start_date as string | null) ?? null,
    due_date: (row.due_date as string | null) ?? null,
    closed_on: (row.closed_on as string | null) ?? null,
    time_budget_hours:
      row.time_budget_seconds === null || row.time_budget_seconds === undefined
        ? null
        : Math.floor(Number(row.time_budget_seconds) / 3600),
    status_type: (row.status_type as string | null) ?? null,
    status_name: (row.status_name as string | null) ?? null,
    description: (row.description as string | null) ?? null,
  };
}

/** The mapping target of a record, resolved to a display name. One
 *  LATERAL per record type so the four Dante tables stay decoupled. */
const MAPPED = sql`
  LEFT JOIN LATERAL (
    SELECT l.dante_type, l.dante_id,
           CASE l.dante_type
             WHEN 'employee'   THEN (SELECT ec.first_name || ' ' || ec.last_name FROM employee_current ec WHERE ec.employee_id = l.dante_id)
             WHEN 'freelancer' THEN (SELECT f.name FROM freelancer f WHERE f.freelancer_id = l.dante_id)
             WHEN 'project'    THEN (SELECT p.name FROM project p WHERE p.project_id = l.dante_id)
             WHEN 'customer'   THEN (SELECT c.name FROM customer c WHERE c.customer_id = l.dante_id)
           END AS mapped_name,
           CASE l.dante_type
             WHEN 'project' THEN (SELECT c.name FROM project p JOIN customer c ON c.customer_id = p.customer_id WHERE p.project_id = l.dante_id)
           END AS mapped_customer_name
    FROM external_link l
    WHERE l.integration_slug = x.integration_slug
      AND l.entity_type = x.entity_type
      AND l.external_id = x.external_id
  ) m ON TRUE
`;

/** List one integration's records of one type, with mapping status and
 *  activity counts. `mapped` null = all; `q` filters by name (and, for
 *  projects, parent or company name); archived records are hidden unless
 *  `include_archived`. */
export async function listExternalRecords(opts: {
  slug: string;
  entity_type: ExternalEntityType;
  mapped: boolean | null;
  q: string | null;
  include_archived: boolean;
}): Promise<ExternalRecordRow[]> {
  const conds = [sql`x.integration_slug = ${opts.slug}`];
  if (opts.mapped === true) conds.push(sql`m.dante_id IS NOT NULL`);
  else if (opts.mapped === false) conds.push(sql`m.dante_id IS NULL`);
  if (!opts.include_archived) conds.push(sql`x.active IS NOT false`);
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push(
      sql`(LOWER(x.name) LIKE LOWER(${like}) OR LOWER(COALESCE(x.secondary, '')) LIKE LOWER(${like}) OR LOWER(COALESCE(x.parent_name, '')) LIKE LOWER(${like}))`,
    );
  }
  const where = sql.join(conds, sql` AND `);

  let base;
  let order;
  switch (opts.entity_type) {
    case "person":
      base = sql`
        SELECT p.integration_slug, 'person'::text AS entity_type, p.external_id,
               TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS name,
               p.email AS secondary, p.is_active AS active, p.is_external,
               NULL::boolean AS billable, NULL::text AS parent_external_id, NULL::text AS parent_name,
               NULL::date AS start_date, NULL::date AS due_date, NULL::date AS closed_on,
               NULL::bigint AS time_budget_seconds, NULL::text AS status_type, NULL::text AS status_name,
               NULL::text AS description, p.last_name AS sort_name,
               (SELECT COUNT(*) FROM time_entry t
                 WHERE t.integration_slug = p.integration_slug AND t.external_person_id = p.external_id) AS n_entries
        FROM external_person p`;
      order = sql`ORDER BY n_entries DESC, sort_name`;
      break;
    case "company":
      base = sql`
        SELECT c.integration_slug, 'company'::text AS entity_type, c.external_id,
               c.name, NULL::text AS secondary, NULL::boolean AS active, c.is_external,
               NULL::boolean AS billable, NULL::text AS parent_external_id, NULL::text AS parent_name,
               NULL::date AS start_date, NULL::date AS due_date, NULL::date AS closed_on,
               NULL::bigint AS time_budget_seconds, NULL::text AS status_type, NULL::text AS status_name,
               NULL::text AS description, c.name AS sort_name,
               (SELECT COUNT(*) FROM external_project ep
                 WHERE ep.integration_slug = c.integration_slug AND ep.external_company_id = c.external_id) AS n_entries
        FROM external_company c`;
      order = sql`ORDER BY n_entries DESC NULLS LAST, sort_name`;
      break;
    case "project":
      base = sql`
        SELECT ep.integration_slug, 'project'::text AS entity_type, ep.external_id,
               ep.name, co.name AS secondary, ep.active, (ep.extra ->> 'is_external')::boolean AS is_external,
               ep.billable, ep.parent_external_id, par.name AS parent_name,
               ep.start_date, ep.due_date, ep.closed_on, ep.time_budget_seconds,
               ep.status_type, ep.status_name, ep.description, ep.name AS sort_name,
               (SELECT COUNT(*) FROM time_entry t
                 WHERE t.integration_slug = ep.integration_slug AND t.external_project_id = ep.external_id) AS n_entries
        FROM external_project ep
        LEFT JOIN external_company co
          ON co.integration_slug = ep.integration_slug AND co.external_id = ep.external_company_id
        LEFT JOIN external_project par
          ON par.integration_slug = ep.integration_slug AND par.external_id = ep.parent_external_id`;
      // Subtrees together: root name, parents before children, then name.
      order = sql`ORDER BY LOWER(COALESCE(parent_name, name)), (parent_external_id IS NOT NULL), n_entries DESC, LOWER(name)`;
      break;
  }

  const r = await db.execute(sql`
    SELECT x.*, m.dante_type, m.dante_id, m.mapped_name, m.mapped_customer_name
    FROM (${base}) x
    ${MAPPED}
    WHERE ${where}
    ${order}
  `);
  return (r.rows as Raw[]).map((row) => toRow(opts.entity_type, row));
}

export type ImportableProjectRow = ExternalRecordRow & {
  /** The customer the project's company is linked to. */
  company_mapped_to: MappedTo | null;
};

/** Projects of `slug` whose company is linked to a customer but which are
 *  not linked to a Dante project themselves — the import picker. */
export async function listImportableProjects(opts: {
  slug: string;
  customer_id: number | null;
}): Promise<ImportableProjectRow[]> {
  const conds = [sql`x.integration_slug = ${opts.slug}`, sql`cl.dante_id IS NOT NULL`, sql`m.dante_id IS NULL`];
  if (opts.customer_id !== null && Number.isInteger(opts.customer_id)) {
    conds.push(sql`cl.dante_id = ${opts.customer_id}`);
  }
  const r = await db.execute(sql`
    SELECT x.*, m.dante_type, m.dante_id, m.mapped_name, m.mapped_customer_name,
           cl.dante_id AS company_customer_id, cu.name AS company_customer_name
    FROM (
      SELECT ep.integration_slug, 'project'::text AS entity_type, ep.external_id,
             ep.name, co.name AS secondary, ep.active, (ep.extra ->> 'is_external')::boolean AS is_external,
             ep.billable, ep.parent_external_id, NULL::text AS parent_name,
             ep.start_date, ep.due_date, ep.closed_on, ep.time_budget_seconds,
             ep.status_type, ep.status_name, ep.description, ep.external_company_id,
             (SELECT COUNT(*) FROM time_entry t
               WHERE t.integration_slug = ep.integration_slug AND t.external_project_id = ep.external_id) AS n_entries
      FROM external_project ep
      LEFT JOIN external_company co
        ON co.integration_slug = ep.integration_slug AND co.external_id = ep.external_company_id
    ) x
    ${MAPPED}
    LEFT JOIN external_link cl
      ON cl.integration_slug = x.integration_slug AND cl.entity_type = 'company'
     AND cl.external_id = x.external_company_id
    LEFT JOIN customer cu ON cu.customer_id = cl.dante_id
    WHERE ${sql.join(conds, sql` AND `)}
      AND x.name IS NOT NULL
    ORDER BY x.n_entries DESC, x.name
  `);
  return (r.rows as Raw[]).map((row) => ({
    ...toRow("project", row),
    company_mapped_to:
      row.company_customer_id === null || row.company_customer_id === undefined
        ? null
        : {
            dante_type: "customer",
            dante_id: Number(row.company_customer_id),
            name: (row.company_customer_name as string | null) ?? null,
            customer_name: null,
          },
  }));
}

export type LinkRow = ExternalRecordRow & { integration_name: string; mapped_at: Date };

/** Every external record linked to one Dante entity, across integrations. */
export async function listLinksFor(opts: {
  dante_type: DanteEntityType;
  dante_id: number;
}): Promise<LinkRow[]> {
  const entity_type: ExternalEntityType =
    opts.dante_type === "employee" || opts.dante_type === "freelancer"
      ? "person"
      : opts.dante_type === "project"
        ? "project"
        : "company";
  const r = await db.execute(sql`
    SELECT l.integration_slug, l.external_id, l.mapped_at, i.display_name AS integration_name,
           ${
             entity_type === "person"
               ? sql`TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS name, p.email AS secondary, p.is_active AS active, p.is_external,
                     NULL::boolean AS billable, NULL::text AS parent_external_id, NULL::text AS parent_name,
                     NULL::date AS start_date, NULL::date AS due_date, NULL::date AS closed_on, NULL::bigint AS time_budget_seconds,
                     NULL::text AS status_type, NULL::text AS status_name, NULL::text AS description,
                     (SELECT COUNT(*) FROM time_entry t WHERE t.integration_slug = l.integration_slug AND t.external_person_id = l.external_id) AS n_entries`
               : entity_type === "project"
                 ? sql`ep.name, co.name AS secondary, ep.active, (ep.extra ->> 'is_external')::boolean AS is_external,
                       ep.billable, ep.parent_external_id, par.name AS parent_name,
                       ep.start_date, ep.due_date, ep.closed_on, ep.time_budget_seconds,
                       ep.status_type, ep.status_name, ep.description,
                       (SELECT COUNT(*) FROM time_entry t WHERE t.integration_slug = l.integration_slug AND t.external_project_id = l.external_id) AS n_entries`
                 : sql`c.name, NULL::text AS secondary, NULL::boolean AS active, c.is_external,
                       NULL::boolean AS billable, NULL::text AS parent_external_id, NULL::text AS parent_name,
                       NULL::date AS start_date, NULL::date AS due_date, NULL::date AS closed_on, NULL::bigint AS time_budget_seconds,
                       NULL::text AS status_type, NULL::text AS status_name, NULL::text AS description,
                       (SELECT COUNT(*) FROM external_project ep2 WHERE ep2.integration_slug = c.integration_slug AND ep2.external_company_id = c.external_id) AS n_entries`
           }
    FROM external_link l
    JOIN integration i ON i.slug = l.integration_slug
    ${
      entity_type === "person"
        ? sql`LEFT JOIN external_person p ON p.integration_slug = l.integration_slug AND p.external_id = l.external_id`
        : entity_type === "project"
          ? sql`LEFT JOIN external_project ep ON ep.integration_slug = l.integration_slug AND ep.external_id = l.external_id
                LEFT JOIN external_company co ON co.integration_slug = ep.integration_slug AND co.external_id = ep.external_company_id
                LEFT JOIN external_project par ON par.integration_slug = ep.integration_slug AND par.external_id = ep.parent_external_id`
          : sql`LEFT JOIN external_company c ON c.integration_slug = l.integration_slug AND c.external_id = l.external_id`
    }
    WHERE l.entity_type = ${entity_type} AND l.dante_type = ${opts.dante_type} AND l.dante_id = ${opts.dante_id}
    ORDER BY i.display_name, name
  `);
  return (r.rows as Raw[]).map((row) => ({
    ...toRow(entity_type, { ...row, dante_type: opts.dante_type, dante_id: opts.dante_id }),
    integration_name: row.integration_name as string,
    mapped_at: row.mapped_at as Date,
  }));
}

/** Minimal facts about one record — enough for the link / import actions
 *  to validate and to write sensible messages. Null when the row is gone. */
export async function getExternalRecord(
  slug: string,
  entity_type: ExternalEntityType,
  external_id: string,
): Promise<{ name: string | null; billable: boolean | null } | null> {
  const r = await db.execute(
    entity_type === "person"
      ? sql`SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name, NULL::boolean AS billable
              FROM external_person WHERE integration_slug = ${slug} AND external_id = ${external_id}`
      : entity_type === "project"
        ? sql`SELECT name, billable FROM external_project WHERE integration_slug = ${slug} AND external_id = ${external_id}`
        : sql`SELECT name, NULL::boolean AS billable FROM external_company WHERE integration_slug = ${slug} AND external_id = ${external_id}`,
  );
  const row = (r.rows as Raw[])[0];
  if (!row) return null;
  return { name: (row.name as string | null) ?? null, billable: (row.billable as boolean | null) ?? null };
}

export async function getLinkTarget(
  slug: string,
  entity_type: ExternalEntityType,
  external_id: string,
): Promise<{ dante_type: DanteEntityType; dante_id: number } | null> {
  const [row] = await db
    .select({ dante_type: externalLink.dante_type, dante_id: externalLink.dante_id })
    .from(externalLink)
    .where(
      and(
        eq(externalLink.integration_slug, slug),
        eq(externalLink.entity_type, entity_type),
        eq(externalLink.external_id, external_id),
      ),
    );
  return row ?? null;
}

export async function insertExternalLink(input: {
  integration_slug: string;
  entity_type: ExternalEntityType;
  external_id: string;
  dante_type: DanteEntityType;
  dante_id: number;
}): Promise<void> {
  await db.insert(externalLink).values({ ...input, origin: "manual", mapped_at: new Date() });
}

export async function deleteExternalLink(input: {
  integration_slug: string;
  entity_type: ExternalEntityType;
  external_id: string;
  dante_type: DanteEntityType;
  dante_id: number;
}): Promise<number> {
  const rows = await db
    .delete(externalLink)
    .where(
      and(
        eq(externalLink.integration_slug, input.integration_slug),
        eq(externalLink.entity_type, input.entity_type),
        eq(externalLink.external_id, input.external_id),
        eq(externalLink.dante_type, input.dante_type),
        eq(externalLink.dante_id, input.dante_id),
      ),
    )
    .returning({ id: externalLink.external_id });
  return rows.length;
}

export type ProjectImportContext = {
  name: string | null;
  external_company_id: string | null;
  start_date: string | null;
  due_date: string | null;
  closed_on: string | null;
  time_budget_seconds: number | null;
  status_type: string | null;
  description: string | null;
  billable: boolean | null;
  /** Customer the project's company is linked to, if any. */
  linked_customer_id: number | null;
};

/** The external project plus its company → customer link in one
 *  round-trip, for the import action. */
export async function getProjectImportContext(
  slug: string,
  external_id: string,
): Promise<ProjectImportContext | null> {
  const r = await db.execute(sql`
    SELECT ep.name, ep.external_company_id, ep.start_date::text AS start_date, ep.due_date::text AS due_date,
           ep.closed_on::text AS closed_on, ep.time_budget_seconds, ep.status_type, ep.description, ep.billable,
           cl.dante_id AS linked_customer_id
    FROM external_project ep
    LEFT JOIN external_link cl
      ON cl.integration_slug = ep.integration_slug AND cl.entity_type = 'company'
     AND cl.external_id = ep.external_company_id
    WHERE ep.integration_slug = ${slug} AND ep.external_id = ${external_id}
  `);
  const row = (r.rows as Raw[])[0];
  if (!row) return null;
  return {
    name: (row.name as string | null) ?? null,
    external_company_id: (row.external_company_id as string | null) ?? null,
    start_date: (row.start_date as string | null) ?? null,
    due_date: (row.due_date as string | null) ?? null,
    closed_on: (row.closed_on as string | null) ?? null,
    time_budget_seconds:
      row.time_budget_seconds === null || row.time_budget_seconds === undefined ? null : Number(row.time_budget_seconds),
    status_type: (row.status_type as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    billable: (row.billable as boolean | null) ?? null,
    linked_customer_id: (row.linked_customer_id as number | null) ?? null,
  };
}
