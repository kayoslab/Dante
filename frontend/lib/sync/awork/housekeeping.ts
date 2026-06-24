/** Post-sync awork housekeeping — pure DB operations.
 *
 * Runs after the awork pull inside `npm run sync`. Three passes:
 *
 *   1. bulkImportFromAwork:        unmapped awork companies → customer,
 *                                  unmapped awork projects → project.
 *   2. applyAworkMoneyToImported:  Fixed Price / Daily Rate / Order #
 *                                  → project.agreed_amount, project_rate, notes.
 *   3. backfillImportedProjects:   refresh planned dates / time_budget /
 *                                  status from awork.
 *
 * Planning-data rollup into `assignment` lives in
 * `rollupAworkPlanningsToAssignments` in sync.ts.
 */
import type { Client } from "pg";

import {
  aworkCompanyLink,
  aworkProjectLink,
  customer,
  project,
} from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";

/** HTML → plain text. Same passes as lib/actions/awork-import.ts::stripHtml. */
function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  let cleaned = html.replace(/<\/(p|li|h[1-6]|div|br\/?)\s*>/gi, "\n");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}


// ----------------------------------------------------------------------------
// applyAworkMoneyToImported
// ----------------------------------------------------------------------------

export type ApplyMoneyResult = {
  linked_projects: number;
  billing_model_flipped_to_fp: number;
  agreed_amount_set: number;
  project_rates_upserted: number;
  time_budget_set: number;
  notes_extended: number;
  errors: Array<{ project_id: number; error: string }>;
  default_profile_name: string;
};

export async function applyAworkMoneyToImported(
  conn: Client,
  opts: { default_profile_name?: string } = {},
): Promise<ApplyMoneyResult> {
  const default_profile_name = opts.default_profile_name ?? "default";
  const rows = await conn.query<{
    project_id: number;
    billing_model: string;
    agreed_amount_eur: string | null;
    planned_start_date: string | null;
    time_budget_hours: number | null;
    notes: string | null;
    daily_rate_eur: string | null;
    fixed_price_eur: string | null;
    order_number: string | null;
    time_budget_seconds: number | null;
  }>(`
    SELECT p.project_id, p.billing_model, p.agreed_amount_eur,
           p.planned_start_date, p.time_budget_hours, p.notes,
           ap.daily_rate_eur, ap.fixed_price_eur, ap.order_number,
           ap.time_budget_seconds
    FROM awork_project_link link
    JOIN project p USING (project_id)
    JOIN awork_project ap USING (awork_project_id)
  `);

  const result: ApplyMoneyResult = {
    linked_projects: rows.rows.length,
    billing_model_flipped_to_fp: 0,
    agreed_amount_set: 0,
    project_rates_upserted: 0,
    time_budget_set: 0,
    notes_extended: 0,
    errors: [],
    default_profile_name,
  };
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const r of rows.rows) {
    try {
      // 1. Fixed Price → billing_model + agreed_amount.
      if (r.fixed_price_eur !== null) {
        if (r.billing_model !== "fixed_price") {
          await conn.query(
            "UPDATE project SET billing_model = 'fixed_price', updated_at = $1 WHERE project_id = $2",
            [now, r.project_id],
          );
          result.billing_model_flipped_to_fp += 1;
        }
        if (r.agreed_amount_eur === null) {
          await conn.query(
            "UPDATE project SET agreed_amount_eur = $1, updated_at = $2 WHERE project_id = $3",
            [Number(r.fixed_price_eur), now, r.project_id],
          );
          result.agreed_amount_set += 1;
        }
      }
      // 2. Daily Rate → upsert project_rate(default profile).
      if (r.daily_rate_eur !== null && Number(r.daily_rate_eur) > 0) {
        const valid_from = r.planned_start_date ?? today;
        await conn.query(
          `INSERT INTO project_rate (project_id, profile, valid_from, daily_rate_eur)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, profile, valid_from)
           DO UPDATE SET daily_rate_eur = EXCLUDED.daily_rate_eur`,
          [
            r.project_id,
            default_profile_name,
            valid_from,
            Number(r.daily_rate_eur),
          ],
        );
        result.project_rates_upserted += 1;
      }
      // 3. time_budget_seconds → time_budget_hours. Awork is the
      // authoritative source — the previous "only if unset" guard
      // froze stale values whenever a budget was edited in awork
      // after initial sync (a large customer project hit this
      // in prod: synced as 4h, awork later bumped to 4d/32h, our
      // value stayed at 4h forever). Now: reconcile every run when
      // the value differs.
      if (r.time_budget_seconds !== null) {
        const hours = Math.floor(Number(r.time_budget_seconds) / 3600);
        if (hours > 0 && hours !== r.time_budget_hours) {
          await conn.query(
            "UPDATE project SET time_budget_hours = $1, updated_at = $2 WHERE project_id = $3",
            [hours, now, r.project_id],
          );
          result.time_budget_set += 1;
        }
      }
      // 4. Order number → append to notes.
      if (r.order_number) {
        const tag = `PO: ${r.order_number}`;
        if (!(r.notes ?? "").includes(tag)) {
          const new_notes = (r.notes ? r.notes + "\n\n" : "") + tag;
          await conn.query(
            "UPDATE project SET notes = $1, updated_at = $2 WHERE project_id = $3",
            [new_notes, now, r.project_id],
          );
          result.notes_extended += 1;
        }
      }
    } catch (err) {
      result.errors.push({
        project_id: r.project_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// backfillImportedProjects
// ----------------------------------------------------------------------------

export type BackfillImportedResult = {
  linked_projects: number;
  updated: number;
  unchanged: number;
  overwrite_existing: boolean;
};

export async function backfillImportedProjects(
  conn: Client,
  opts: { overwrite_existing?: boolean } = {},
): Promise<BackfillImportedResult> {
  const overwrite_existing = opts.overwrite_existing ?? false;
  const rows = await conn.query<{
    project_id: number;
    status: string;
    planned_start_date: string | null;
    planned_end_date: string | null;
    time_budget_hours: number | null;
    notes: string | null;
    ap_start: string | null;
    ap_due: string | null;
    ap_budget_sec: number | null;
    ap_desc: string | null;
    ap_status_type: string | null;
  }>(`
    SELECT p.project_id, p.status, p.planned_start_date, p.planned_end_date,
           p.time_budget_hours, p.notes,
           ap.start_date AS ap_start, ap.due_date AS ap_due,
           ap.time_budget_seconds AS ap_budget_sec,
           ap.description AS ap_desc,
           ap.project_status_type AS ap_status_type
    FROM awork_project_link link
    JOIN project p USING (project_id)
    JOIN awork_project ap USING (awork_project_id)
  `);

  const pick = <T,>(current: T, fresh: T): T => {
    if (overwrite_existing) return fresh !== null ? fresh : current;
    return current !== null ? current : fresh;
  };

  let n_updated = 0;
  let n_skipped = 0;
  for (const r of rows.rows) {
    const cur_start = r.planned_start_date;
    const cur_end = r.planned_end_date;
    const cur_budget = r.time_budget_hours;
    const cur_notes = r.notes;
    const ap_budget_h =
      r.ap_budget_sec === null
        ? null
        : Math.floor(Number(r.ap_budget_sec) / 3600);
    const new_start = pick(cur_start, r.ap_start);
    const new_end = pick(cur_end, r.ap_due);
    const new_budget = pick(cur_budget, ap_budget_h);
    const new_notes = pick(cur_notes, stripHtml(r.ap_desc));

    let new_status = r.status;
    if (r.status === "active") {
      if (r.ap_status_type === "closed") new_status = "completed";
      else if (r.ap_status_type === "archived") new_status = "cancelled";
    }

    const unchanged =
      new_start === cur_start &&
      new_end === cur_end &&
      new_budget === cur_budget &&
      new_notes === cur_notes &&
      new_status === r.status;
    if (unchanged) {
      n_skipped += 1;
      continue;
    }
    await conn.query(
      `UPDATE project SET planned_start_date = $1, planned_end_date = $2,
         time_budget_hours = $3, notes = $4, status = $5, updated_at = $6
       WHERE project_id = $7`,
      [
        new_start,
        new_end,
        new_budget,
        new_notes,
        new_status,
        new Date(),
        r.project_id,
      ],
    );
    n_updated += 1;
  }
  return {
    linked_projects: rows.rows.length,
    updated: n_updated,
    unchanged: n_skipped,
    overwrite_existing,
  };
}

// ----------------------------------------------------------------------------
// bulkImportFromAwork — straight-line port. Auto-creates customers from
// unlinked awork companies, then projects from unlinked awork projects
// whose company is now mapped to a customer.
// ----------------------------------------------------------------------------

export type BulkImportResult = {
  auto_linked_companies: number;
  customers_to_create: number;
  customers_created: number;
  customer_errors: Array<{
    awork_company_id: string;
    name: string;
    error: string;
  }>;
  projects_to_create: number;
  projects_created: number;
  project_errors: Array<{
    awork_project_id: string;
    name: string;
    customer: string | null;
    error: string;
  }>;
  projects_skipped_closed: number;
};

export async function bulkImportFromAwork(
  conn: Client,
  opts: {
    billing_model?: "time_and_material" | "fixed_price";
    skip_closed_projects?: boolean;
    dry_run?: boolean;
  } = {},
): Promise<BulkImportResult> {
  const billing_model = opts.billing_model ?? "time_and_material";
  const skip_closed_projects = opts.skip_closed_projects ?? false;
  const dry_run = opts.dry_run ?? false;

  const summary: BulkImportResult = {
    auto_linked_companies: 0,
    customers_to_create: 0,
    customers_created: 0,
    customer_errors: [],
    projects_to_create: 0,
    projects_created: 0,
    project_errors: [],
    projects_skipped_closed: 0,
  };

  // Step 1 — auto-link companies by exact name match.
  if (!dry_run) {
    const { autoLinkAworkCompaniesByName } = await import("./sync");
    const linked = await autoLinkAworkCompaniesByName(conn);
    summary.auto_linked_companies = linked.new_links;
  }

  // Step 2 — import unlinked awork companies → create customer.
  const unlinked = await conn.query<{
    awork_company_id: string;
    name: string;
  }>(`
    SELECT aco.awork_company_id, aco.name
    FROM awork_company aco
    LEFT JOIN awork_company_link link ON link.awork_company_id = aco.awork_company_id
    WHERE link.awork_company_id IS NULL AND aco.name IS NOT NULL
  `);
  summary.customers_to_create = unlinked.rows.length;
  if (dry_run) {
    summary.customers_created = unlinked.rows.length;
  } else {
    const now = new Date();
    for (const co of unlinked.rows) {
      try {
        // Skip if a customer with the same name already exists — UNIQUE
        // constraint would error anyway, and we'd just want to link instead.
        const dup = await conn.query(
          "SELECT customer_id FROM customer WHERE LOWER(name) = LOWER($1)",
          [co.name],
        );
        const db = syncDrizzle(conn);
        let customer_id: number;
        if (dup.rows.length > 0) {
          customer_id = (dup.rows[0] as { customer_id: number }).customer_id;
        } else {
          const [ins] = await db
            .insert(customer)
            .values({ name: co.name, created_at: now, updated_at: now })
            .returning({ customer_id: customer.customer_id });
          customer_id = ins.customer_id;
        }
        await db
          .insert(aworkCompanyLink)
          .values({
            awork_company_id: co.awork_company_id,
            customer_id,
            mapped_at: now,
          })
          .onConflictDoNothing();
        summary.customers_created += 1;
      } catch (err) {
        summary.customer_errors.push({
          awork_company_id: co.awork_company_id,
          name: co.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Step 3 — import unlinked awork projects whose company is mapped.
  const importable = await conn.query<{
    awork_project_id: string;
    name: string;
    awork_company_id: string;
    project_status_type: string | null;
    start_date: string | null;
    due_date: string | null;
    time_budget_seconds: number | null;
    description: string | null;
    customer_id: number | null;
    customer_name: string | null;
  }>(`
    SELECT ap.awork_project_id, ap.name, ap.awork_company_id,
           ap.project_status_type, ap.start_date, ap.due_date,
           ap.time_budget_seconds, ap.description,
           link.customer_id, c.name AS customer_name
    FROM awork_project ap
    LEFT JOIN awork_project_link apl ON apl.awork_project_id = ap.awork_project_id
    LEFT JOIN awork_company_link link ON link.awork_company_id = ap.awork_company_id
    LEFT JOIN customer c ON c.customer_id = link.customer_id
    WHERE apl.awork_project_id IS NULL
      AND link.customer_id IS NOT NULL
      AND ap.name IS NOT NULL
  `);
  summary.projects_to_create = importable.rows.length;

  if (!dry_run) {
    const now = new Date();
    for (const p of importable.rows) {
      if (skip_closed_projects && p.project_status_type === "closed") {
        summary.projects_skipped_closed += 1;
        continue;
      }
      try {
        let our_status = "active";
        if (p.project_status_type === "closed") our_status = "completed";
        else if (p.project_status_type === "archived") our_status = "cancelled";
        const time_budget_hours =
          p.time_budget_seconds === null
            ? null
            : Math.floor(Number(p.time_budget_seconds) / 3600);
        const notes = stripHtml(p.description);
        const db = syncDrizzle(conn);
        const [ins] = await db
          .insert(project)
          .values({
            customer_id: p.customer_id ?? 0,
            name: p.name,
            billing_model,
            planned_start_date: p.start_date,
            planned_end_date: p.due_date,
            status: our_status,
            notes,
            time_budget_hours,
            created_at: now,
            updated_at: now,
          })
          .returning({ project_id: project.project_id });
        await db.insert(aworkProjectLink).values({
          awork_project_id: p.awork_project_id,
          project_id: ins.project_id,
          mapped_at: now,
        });
        summary.projects_created += 1;
      } catch (err) {
        summary.project_errors.push({
          awork_project_id: p.awork_project_id,
          name: p.name,
          customer: p.customer_name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    if (skip_closed_projects) {
      summary.projects_skipped_closed = importable.rows.filter(
        (p) => p.project_status_type === "closed",
      ).length;
    }
    summary.projects_created =
      summary.projects_to_create - summary.projects_skipped_closed;
  }

  return summary;
}
