/** Import policy — turning external companies / projects into Dante
 * customers / projects, and keeping imported projects fresh.
 *
 * Driven by the `projects.import_policy` rule:
 *   { integration, customers, projects, refresh_dates, apply_money }
 *
 *   - customers:     unlinked external companies → `customer` (+ link);
 *                    a customer with the same name is linked, not duplicated.
 *   - projects:      unlinked external projects whose company is linked →
 *                    `project` (+ link), pre-filled from the source.
 *   - refresh_dates: planned dates / time budget / notes / status of every
 *                    linked project follow the source (dates always, the
 *                    rest fill-NULL-only so manual curation survives).
 *   - apply_money:   provider-specific (rates, fixed price); handled by the
 *                    provider's `afterSync` hook, which reads the flag.
 *
 * Everything here reads the canonical tables only, so it works for any
 * integration bound to `companies` / `projects`.
 */
import type { Client } from "pg";

import { customer, project } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";

import { insertLink } from "./links";

/** HTML → plain text (source project descriptions → Dante notes). */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  let cleaned = html.replace(/<\/(p|li|h[1-6]|div|br\/?)\s*>/gi, "\n");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Map a source status type onto Dante's project status. */
export function projectStatusFromSource(status_type: string | null): string {
  if (status_type === "closed") return "completed";
  if (status_type === "archived") return "cancelled";
  return "active";
}

export type ImportCustomersResult = {
  to_create: number;
  created: number;
  errors: Array<{ external_id: string; name: string; error: string }>;
};

export async function importCustomers(
  conn: Client,
  slug: string,
): Promise<ImportCustomersResult> {
  const unlinked = await conn.query<{ external_id: string; name: string }>(
    `SELECT co.external_id, co.name
       FROM external_company co
       LEFT JOIN external_link l
         ON l.integration_slug = co.integration_slug
        AND l.entity_type = 'company'
        AND l.external_id = co.external_id
      WHERE co.integration_slug = $1 AND l.external_id IS NULL AND co.name IS NOT NULL`,
    [slug],
  );
  const result: ImportCustomersResult = { to_create: unlinked.rows.length, created: 0, errors: [] };
  const db = syncDrizzle(conn);
  const now = new Date();
  for (const co of unlinked.rows) {
    try {
      const dup = await conn.query<{ customer_id: number }>(
        "SELECT customer_id FROM customer WHERE LOWER(name) = LOWER($1)",
        [co.name],
      );
      let customer_id: number;
      if (dup.rows.length > 0) {
        customer_id = dup.rows[0].customer_id;
      } else {
        const [ins] = await db
          .insert(customer)
          .values({ name: co.name, created_at: now, updated_at: now })
          .returning({ customer_id: customer.customer_id });
        customer_id = ins.customer_id;
      }
      await insertLink(conn, {
        integration_slug: slug,
        entity_type: "company",
        external_id: co.external_id,
        dante_type: "customer",
        dante_id: customer_id,
        origin: "source",
      });
      result.created += 1;
    } catch (err) {
      result.errors.push({
        external_id: co.external_id,
        name: co.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export type ImportProjectsResult = {
  to_create: number;
  created: number;
  errors: Array<{ external_id: string; name: string; customer: string | null; error: string }>;
};

export async function importProjects(
  conn: Client,
  slug: string,
  opts: { billing_model?: "time_and_material" | "fixed_price" } = {},
): Promise<ImportProjectsResult> {
  const billing_model = opts.billing_model ?? "time_and_material";
  const importable = await conn.query<{
    external_id: string;
    name: string;
    status_type: string | null;
    start_date: string | null;
    due_date: string | null;
    time_budget_seconds: string | null;
    description: string | null;
    billable: boolean | null;
    customer_id: number;
    customer_name: string | null;
  }>(
    `SELECT ep.external_id, ep.name, ep.status_type, ep.start_date::text AS start_date,
            ep.due_date::text AS due_date, ep.time_budget_seconds::text AS time_budget_seconds,
            ep.description, ep.billable,
            cl.dante_id AS customer_id, c.name AS customer_name
       FROM external_project ep
       LEFT JOIN external_link pl
         ON pl.integration_slug = ep.integration_slug
        AND pl.entity_type = 'project'
        AND pl.external_id = ep.external_id
       JOIN external_link cl
         ON cl.integration_slug = ep.integration_slug
        AND cl.entity_type = 'company'
        AND cl.external_id = ep.external_company_id
       LEFT JOIN customer c ON c.customer_id = cl.dante_id
      WHERE ep.integration_slug = $1
        AND pl.external_id IS NULL
        AND ep.name IS NOT NULL`,
    [slug],
  );
  const result: ImportProjectsResult = { to_create: importable.rows.length, created: 0, errors: [] };
  const db = syncDrizzle(conn);
  const now = new Date();
  for (const p of importable.rows) {
    try {
      const time_budget_hours =
        p.time_budget_seconds === null ? null : Math.floor(Number(p.time_budget_seconds) / 3600);
      const [ins] = await db
        .insert(project)
        .values({
          customer_id: p.customer_id,
          name: p.name,
          billing_model,
          planned_start_date: p.start_date,
          planned_end_date: p.due_date,
          status: projectStatusFromSource(p.status_type),
          notes: stripHtml(p.description),
          time_budget_hours,
          // Seed billability from the source's own flag; null → billable.
          billable: p.billable ?? true,
          created_at: now,
          updated_at: now,
        })
        .returning({ project_id: project.project_id });
      await insertLink(conn, {
        integration_slug: slug,
        entity_type: "project",
        external_id: p.external_id,
        dante_type: "project",
        dante_id: ins.project_id,
        origin: "source",
      });
      result.created += 1;
    } catch (err) {
      result.errors.push({
        external_id: p.external_id,
        name: p.name,
        customer: p.customer_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export type RefreshProjectsResult = { linked_projects: number; updated: number; unchanged: number };

/** Keep linked projects in step with their source. Planned dates are
 * source-owned (the source wins whenever it has a value; a date is never
 * blanked). Time budget and notes fill NULL only, so manual curation in
 * Dante survives. An `active` Dante project follows the source into
 * completed / cancelled. */
export async function refreshImportedProjects(
  conn: Client,
  slug: string,
): Promise<RefreshProjectsResult> {
  const rows = await conn.query<{
    project_id: number;
    status: string;
    planned_start_date: string | null;
    planned_end_date: string | null;
    time_budget_hours: number | null;
    notes: string | null;
    src_start: string | null;
    src_due: string | null;
    src_budget_sec: string | null;
    src_desc: string | null;
    src_status_type: string | null;
  }>(
    `SELECT p.project_id, p.status,
            p.planned_start_date::text AS planned_start_date,
            p.planned_end_date::text AS planned_end_date,
            p.time_budget_hours, p.notes,
            ep.start_date::text AS src_start, ep.due_date::text AS src_due,
            ep.time_budget_seconds::text AS src_budget_sec,
            ep.description AS src_desc, ep.status_type AS src_status_type
       FROM external_link l
       JOIN project p ON p.project_id = l.dante_id
       JOIN external_project ep
         ON ep.integration_slug = l.integration_slug AND ep.external_id = l.external_id
      WHERE l.integration_slug = $1 AND l.entity_type = 'project'`,
    [slug],
  );

  const fillNull = <T,>(current: T | null, fresh: T | null): T | null =>
    current !== null ? current : fresh;
  const sourceWins = (current: string | null, fresh: string | null): string | null =>
    fresh !== null ? fresh : current;

  let updated = 0;
  let unchanged = 0;
  for (const r of rows.rows) {
    const src_budget_h = r.src_budget_sec === null ? null : Math.floor(Number(r.src_budget_sec) / 3600);
    const new_start = sourceWins(r.planned_start_date, r.src_start);
    const new_end = sourceWins(r.planned_end_date, r.src_due);
    const new_budget = fillNull(r.time_budget_hours, src_budget_h);
    const new_notes = fillNull(r.notes, stripHtml(r.src_desc));
    let new_status = r.status;
    if (r.status === "active") {
      const mapped = projectStatusFromSource(r.src_status_type);
      if (mapped !== "active") new_status = mapped;
    }
    if (
      new_start === r.planned_start_date &&
      new_end === r.planned_end_date &&
      new_budget === r.time_budget_hours &&
      new_notes === r.notes &&
      new_status === r.status
    ) {
      unchanged += 1;
      continue;
    }
    await conn.query(
      `UPDATE project SET planned_start_date = $1, planned_end_date = $2,
         time_budget_hours = $3, notes = $4, status = $5, updated_at = $6
       WHERE project_id = $7`,
      [new_start, new_end, new_budget, new_notes, new_status, new Date(), r.project_id],
    );
    updated += 1;
  }
  return { linked_projects: rows.rows.length, updated, unchanged };
}
