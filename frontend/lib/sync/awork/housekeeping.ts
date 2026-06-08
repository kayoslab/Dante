/** Post-sync awork housekeeping — pure DB operations.
 *
 * Port of src/dante/services/awork_housekeeping.py. Runs automatically
 * after the awork pull inside `bun run sync`. Five passes:
 *
 *   1. bulkImportFromAwork:            unmapped awork companies → customer,
 *                                      unmapped awork projects → project.
 *   2. applyAworkMoneyToImported:      Fixed Price / Daily Rate / Order #
 *                                      → project.agreed_amount, project_rate,
 *                                        notes.
 *   3. backfillImportedProjects:       refresh planned dates / time_budget /
 *                                      status from awork.
 *   4. deriveAssignmentsFromAwork:     auto-create [awork-derived] assignments
 *                                      from tracked time.
 *   5. closeStaleDerivedAssignments:   close [awork-derived] when activity
 *                                      stops or planned end is past.
 */
import type { Client } from "pg";

import {
  aworkCompanyLink,
  aworkProjectLink,
  customer,
  project,
} from "@/lib/db/schema";
import { germanFederalHolidays } from "@/lib/db/_de-holidays";
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

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return isoDay(d);
}

function diffDays(a: string, b: string): number {
  return Math.floor(
    (new Date(a + "T00:00:00Z").getTime() -
      new Date(b + "T00:00:00Z").getTime()) /
      86_400_000,
  );
}

// ----------------------------------------------------------------------------
// closeStaleDerivedAssignments
// ----------------------------------------------------------------------------

export type CloseStaleResult = {
  stale_threshold_days: number;
  planned_end_grace_days: number;
  n_closed: number;
  dry_run: boolean;
  changes: Array<{
    assignment_id: number;
    new_end_date: string;
    last_log: string;
    stale_days: number;
    planned_end_date: string | null;
    planned_end_days_past: number | null;
    triggers: string[];
  }>;
};

export async function closeStaleDerivedAssignments(
  conn: Client,
  opts: {
    stale_threshold_days?: number;
    planned_end_grace_days?: number;
    dry_run?: boolean;
  } = {},
): Promise<CloseStaleResult> {
  const stale_threshold_days = opts.stale_threshold_days ?? 14;
  const planned_end_grace_days = opts.planned_end_grace_days ?? 14;
  const dry_run = opts.dry_run ?? false;

  const rows = await conn.query<{
    assignment_id: number;
    start_date: string;
    planned_end_date: string | null;
    last_log: string | null;
  }>(`
    WITH derived AS (
      SELECT a.assignment_id, a.project_id, a.employee_id,
             a.start_date, p.planned_end_date
      FROM assignment a
      JOIN project p ON p.project_id = a.project_id
      WHERE a.end_date IS NULL
        AND a.employee_id IS NOT NULL
        AND a.notes LIKE '%awork-derived%'
    )
    SELECT d.assignment_id, d.start_date, d.planned_end_date,
           MAX(t.work_date) AS last_log
    FROM derived d
    LEFT JOIN awork_project_link apl ON apl.project_id = d.project_id
    LEFT JOIN awork_user_link ul ON ul.employee_id = d.employee_id
    LEFT JOIN awork_time_entry t
      ON t.awork_project_id = apl.awork_project_id
     AND t.awork_user_id = ul.awork_user_id
    GROUP BY d.assignment_id, d.start_date, d.planned_end_date
  `);

  const today = todayIso();
  const changes: CloseStaleResult["changes"] = [];

  for (const r of rows.rows) {
    if (r.last_log === null) continue;
    const last_log = isoDay(new Date(r.last_log));
    const stale_days = diffDays(today, last_log);
    const planned_end =
      r.planned_end_date === null ? null : isoDay(new Date(r.planned_end_date));
    const planned_end_days_past =
      planned_end === null ? null : diffDays(today, planned_end);

    const triggers: string[] = [];
    if (stale_days > stale_threshold_days)
      triggers.push(`stale ${stale_days}d`);
    if (
      planned_end_days_past !== null &&
      planned_end_days_past > planned_end_grace_days
    ) {
      triggers.push(`planned end ${planned_end_days_past}d past`);
    }
    if (triggers.length === 0) continue;

    const start_date = isoDay(new Date(r.start_date));
    const candidates: string[] = [last_log, start_date];
    if (planned_end !== null) candidates.push(planned_end);
    let end_date = candidates.reduce((a, b) => (a > b ? a : b));
    if (end_date > today) end_date = today;

    changes.push({
      assignment_id: r.assignment_id,
      new_end_date: end_date,
      last_log,
      stale_days,
      planned_end_date: planned_end,
      planned_end_days_past,
      triggers,
    });

    if (!dry_run) {
      await conn.query(
        "UPDATE assignment SET end_date = $1, updated_at = CURRENT_TIMESTAMP WHERE assignment_id = $2",
        [end_date, r.assignment_id],
      );
    }
  }

  return {
    stale_threshold_days,
    planned_end_grace_days,
    n_closed: changes.length,
    dry_run,
    changes,
  };
}

// ----------------------------------------------------------------------------
// deriveAssignmentsFromAwork
// ----------------------------------------------------------------------------

export type DeriveAssignmentsResult = {
  candidates: number;
  created: number;
  skipped_existing_assignment: number;
  skipped_no_employee_link: number;
  errors: Array<{ employee_id: number; project_id: number; error: string }>;
  min_total_hours: number;
  default_profile: string;
  recent_window_days: number;
};

export async function deriveAssignmentsFromAwork(
  conn: Client,
  opts: {
    min_total_hours?: number;
    default_profile?: string;
    recent_window_days?: number;
    skip_existing?: boolean;
  } = {},
): Promise<DeriveAssignmentsResult> {
  const min_total_hours = opts.min_total_hours ?? 16;
  const default_profile = opts.default_profile ?? "default";
  const recent_window_days = opts.recent_window_days ?? 7;
  const skip_existing = opts.skip_existing ?? true;

  const rows = await conn.query<{
    employee_id: number | null;
    project_id: number;
    first_log: string;
    last_log: string;
    total_min: string;
  }>(
    `
    SELECT ul.employee_id, apl.project_id,
           MIN(t.work_date) AS first_log,
           MAX(t.work_date) AS last_log,
           SUM(t.duration_minutes) AS total_min
    FROM awork_time_entry t
    JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
    JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
    WHERE t.duration_minutes > 0
    GROUP BY ul.employee_id, apl.project_id
    HAVING SUM(t.duration_minutes) >= $1
    ORDER BY total_min DESC
  `,
    [min_total_hours * 60],
  );

  const today = todayIso();
  const now = new Date();
  const result: DeriveAssignmentsResult = {
    candidates: rows.rows.length,
    created: 0,
    skipped_existing_assignment: 0,
    skipped_no_employee_link: 0,
    errors: [],
    min_total_hours,
    default_profile,
    recent_window_days,
  };

  function workingDaysBetween(start: string, end: string): number {
    if (start > end) return 0;
    const years = new Set<number>();
    for (
      let y = new Date(start + "T00:00:00Z").getUTCFullYear();
      y <= new Date(end + "T00:00:00Z").getUTCFullYear();
      y++
    ) {
      years.add(y);
    }
    const holidays = new Set<string>();
    for (const y of years) {
      for (const k of germanFederalHolidays(y, y).keys()) holidays.add(k);
    }
    let n = 0;
    const cur = new Date(start + "T00:00:00Z");
    const last = new Date(end + "T00:00:00Z");
    while (cur <= last) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6 && !holidays.has(isoDay(cur))) n += 1;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return n;
  }

  for (const r of rows.rows) {
    if (r.employee_id === null) {
      result.skipped_no_employee_link += 1;
      continue;
    }
    const emp_id = r.employee_id;
    const project_id = r.project_id;
    const first_log = isoDay(new Date(r.first_log));
    const last_log = isoDay(new Date(r.last_log));
    try {
      if (skip_existing) {
        const ex = await conn.query(
          "SELECT 1 FROM assignment WHERE employee_id = $1 AND project_id = $2 LIMIT 1",
          [emp_id, project_id],
        );
        if (ex.rows.length > 0) {
          result.skipped_existing_assignment += 1;
          continue;
        }
      }
      const end_date =
        diffDays(today, last_log) <= recent_window_days ? null : last_log;
      const window_end = end_date ?? today;
      const wd = workingDaysBetween(first_log, window_end) || 1;
      const total_hours = Number(r.total_min) / 60;
      const allocation = Math.min(total_hours / (wd * 8), 1);

      await conn.query(
        `INSERT INTO assignment
          (employee_id, project_id, profile, allocation_pct,
           start_date, end_date, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          emp_id,
          project_id,
          default_profile,
          Math.round(allocation * 10000) / 10000,
          first_log,
          end_date,
          "[awork-derived] auto-created from awork time entries; edit if you want a tighter date range or allocation",
          now,
        ],
      );
      result.created += 1;
    } catch (err) {
      result.errors.push({
        employee_id: emp_id,
        project_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
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
  const today = todayIso();

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
      // 3. time_budget_seconds → time_budget_hours (only if unset).
      if (r.time_budget_seconds !== null && r.time_budget_hours === null) {
        const hours = Math.floor(Number(r.time_budget_seconds) / 3600);
        if (hours > 0) {
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
