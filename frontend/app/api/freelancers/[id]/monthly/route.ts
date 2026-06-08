import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import {
  absencesForEmployee, // unused for freelancers but kept for shape parity
  burdenFactor,
  dec,
  entityMonthlyCost,
  fmt,
  fpRecognizedRevenueForMonth,
  holidaysForYearOf,
  lastOfMonth,
  projectTotalWeightedAllocInMonth,
  resolveRateForDay,
  workingDaysInRange,
} from "@/lib/db/_monthly-helpers";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

// Silence unused import for the kept-for-symmetry helper.
void absencesForEmployee;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const freelancer_id = Number(rawId);
    if (!Number.isInteger(freelancer_id)) {
      throw Validation(`invalid freelancer id: ${rawId}`);
    }
    const { searchParams } = new URL(req.url);
    const monthRaw = searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw Validation(`month must be YYYY-MM (got ${JSON.stringify(monthRaw)})`);
    }
    const month_start = `${monthRaw}-01`;
    const month_end = lastOfMonth(month_start);

    const r = await db.execute(sql`
      SELECT name FROM freelancer WHERE freelancer_id = ${freelancer_id}
    `);
    const flRow = (r.rows as Array<{ name: string }>)[0];
    if (!flRow) throw NotFound(`freelancer not found: ${freelancer_id}`);
    const who_name = flRow.name;

    const holidays = holidaysForYearOf(month_start);
    const working_days = workingDaysInRange(month_start, month_end, holidays);
    const n_wd = working_days.length;
    const burden = await burdenFactor(); // unused for freelancers but kept for symmetry

    const asnRes = await db.execute(sql`
      SELECT a.assignment_id, a.project_id, p.name AS project_name, c.name AS customer_name,
             p.billing_model, p.framework_id, a.profile,
             a.allocation_pct, a.start_date, a.end_date,
             a.daily_rate_override_eur, a.daily_cost_override_eur
      FROM assignment a
      JOIN project p ON p.project_id = a.project_id
      JOIN customer c ON c.customer_id = p.customer_id
      WHERE a.freelancer_id = ${freelancer_id}
        AND a.start_date <= ${month_end}::date
        AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
      ORDER BY a.assignment_id
    `);

    const assignment_rows: Array<Record<string, unknown>> = [];
    let total_revenue = new Decimal(0);
    let total_cost = new Decimal(0);
    const project_weighted_cache = new Map<number, Decimal>();

    for (const raw of asnRes.rows as Array<Record<string, unknown>>) {
      const asn_id = raw.assignment_id as number;
      const project_id = raw.project_id as number;
      const project_name = raw.project_name as string;
      const customer_name = raw.customer_name as string;
      const billing = raw.billing_model as string;
      const framework_id = raw.framework_id as number | null;
      const profile = raw.profile as string | null;
      const alloc = new Decimal(raw.allocation_pct as string);
      const a_start = raw.start_date as string;
      const a_end = raw.end_date as string | null;
      const rate_ov =
        raw.daily_rate_override_eur === null ||
        raw.daily_rate_override_eur === undefined
          ? null
          : new Decimal(raw.daily_rate_override_eur as string);
      const cost_ov =
        raw.daily_cost_override_eur === null ||
        raw.daily_cost_override_eur === undefined
          ? null
          : new Decimal(raw.daily_cost_override_eur as string);

      const a_window_start = a_start > month_start ? a_start : month_start;
      const a_window_end =
        a_end === null ? month_end : a_end < month_end ? a_end : month_end;
      const active_days = working_days.filter(
        (d) => d >= a_window_start && d <= a_window_end,
      );

      // Freelancer cost: daily_cost × active_days × alloc.
      const { monthly_cost: monthly_cost_full } = await entityMonthlyCost(
        null,
        freelancer_id,
        cost_ov,
        burden,
      );
      let cost_share = new Decimal(0);
      if (monthly_cost_full !== null && n_wd > 0 && active_days.length > 0) {
        cost_share = monthly_cost_full
          .mul(alloc)
          .mul(active_days.length)
          .div(n_wd);
      }
      total_cost = total_cost.add(cost_share);

      // Revenue
      let revenue = new Decimal(0);
      let rate_unresolved_days = 0;
      if (billing === "time_and_material") {
        for (const day of active_days) {
          const r2 = await resolveRateForDay(
            project_id,
            framework_id,
            profile,
            day,
            rate_ov,
          );
          if (r2 !== null) {
            revenue = revenue.add(r2.mul(alloc));
          } else {
            rate_unresolved_days++;
          }
        }
      } else {
        const weighted_alloc_i =
          n_wd > 0 ? alloc.mul(active_days.length).div(n_wd) : new Decimal(0);
        if (!project_weighted_cache.has(project_id)) {
          project_weighted_cache.set(
            project_id,
            await projectTotalWeightedAllocInMonth(
              project_id,
              month_start,
              month_end,
              working_days,
            ),
          );
        }
        const proj_total = project_weighted_cache.get(project_id)!;
        const fp_rec = await fpRecognizedRevenueForMonth(
          project_id,
          month_start,
          month_end,
        );
        if (fp_rec !== null && proj_total.gt(0) && weighted_alloc_i.gt(0)) {
          revenue = fp_rec.mul(weighted_alloc_i).div(proj_total);
        }
      }
      total_revenue = total_revenue.add(revenue);

      // declaration order), then FreelancerMonthlyAssignmentRow's own
      // (project_id, project_name, customer_name, billing_model, revenue, cost).
      // Note: base class deliberately omits `revenue` so each subclass can
      // declare it with its own type/nullability — it lands at the end here.
      assignment_rows.push({
        assignment_id: asn_id,
        profile,
        allocation_pct: alloc.toFixed(4),
        active_working_days: active_days.length,
        absence_days: 0,
        billable_days: active_days.length,
        rate_unresolved_days,
        project_id,
        project_name,
        customer_name,
        billing_model: billing,
        revenue: fmt(revenue, 2),
        cost: fmt(cost_share, 2),
      });
    }

    const margin = total_revenue.sub(total_cost);
    const margin_pct = total_cost.gt(0)
      ? margin.div(total_cost).mul(100)
      : null;
    const rate_unresolved_total = assignment_rows.reduce(
      (a, r) => a + (r.rate_unresolved_days as number),
      0,
    );

    return {
      entity_kind: "freelancer",
      entity_id: freelancer_id,
      who_name,
      month: monthRaw,
      month_start,
      month_end,
      working_days_in_month: n_wd,
      cost: fmt(total_cost, 2),
      revenue: fmt(total_revenue, 2),
      margin: fmt(margin, 2),
      margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
      rate_unresolved_days: rate_unresolved_total,
      assignments: assignment_rows,
    };

    // silence the unused-var lint for dec
    void dec;
  });
}
