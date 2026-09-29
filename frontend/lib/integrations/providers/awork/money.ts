/** awork-specific housekeeping: the "Daily Rate" / "Fixed Price" /
 * "Order Number" custom fields onto imported Dante projects.
 *
 * These fields have no canonical home (a project's commercial terms are
 * an awork custom-field convention of this workspace, not a concept every
 * tool shares), so the adapter carries them in `external_project.extra`
 * and applies them here, in `afterSync`:
 *
 *   1. Fixed Price → billing_model = 'fixed_price' + agreed_amount (fill-NULL).
 *   2. Daily Rate  → upsert project_rate for the default profile.
 *   3. Time budget → project.time_budget_hours, reconciled every run —
 *      awork is authoritative (a stale "only if unset" guard once froze a
 *      4h budget that awork had bumped to 32h).
 *   4. Order Number → appended to notes as "PO: <n>" once.
 */
import type { Client } from "pg";

export type ApplyMoneyResult = {
  linked_projects: number;
  billing_model_flipped_to_fp: number;
  agreed_amount_set: number;
  project_rates_upserted: number;
  time_budget_set: number;
  notes_extended: number;
  errors: Array<{ project_id: number; error: string }>;
};

export async function applyAworkMoneyToImported(
  conn: Client,
  slug: string,
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
    time_budget_seconds: string | null;
  }>(
    `SELECT p.project_id, p.billing_model, p.agreed_amount_eur,
            p.planned_start_date::text AS planned_start_date, p.time_budget_hours, p.notes,
            ep.extra ->> 'daily_rate_eur'  AS daily_rate_eur,
            ep.extra ->> 'fixed_price_eur' AS fixed_price_eur,
            ep.extra ->> 'order_number'    AS order_number,
            ep.time_budget_seconds::text   AS time_budget_seconds
       FROM external_link l
       JOIN project p ON p.project_id = l.dante_id
       JOIN external_project ep
         ON ep.integration_slug = l.integration_slug AND ep.external_id = l.external_id
      WHERE l.integration_slug = $1 AND l.entity_type = 'project'`,
    [slug],
  );

  const result: ApplyMoneyResult = {
    linked_projects: rows.rows.length,
    billing_model_flipped_to_fp: 0,
    agreed_amount_set: 0,
    project_rates_upserted: 0,
    time_budget_set: 0,
    notes_extended: 0,
    errors: [],
  };
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const r of rows.rows) {
    try {
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
      if (r.daily_rate_eur !== null && Number(r.daily_rate_eur) > 0) {
        const valid_from = r.planned_start_date ?? today;
        await conn.query(
          `INSERT INTO project_rate (project_id, profile, valid_from, daily_rate_eur)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, profile, valid_from)
           DO UPDATE SET daily_rate_eur = EXCLUDED.daily_rate_eur`,
          [r.project_id, default_profile_name, valid_from, Number(r.daily_rate_eur)],
        );
        result.project_rates_upserted += 1;
      }
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
