import type { NextRequest } from "next/server";

import {
  Validation,
  handle,
  requireApiSession,
} from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { audit } from "@/lib/auth/audit";
import {
  addMonths,
  firstOfMonth,
  mapWithConcurrency,
} from "@/lib/db/_monthly-helpers";
import { computeCustomerMonthlyAggregates } from "@/lib/db/queries/customer-rentability";

/** Trend series for the customer-rentability report.
 *
 * Per month, returns per-customer margin so the stacked-bar chart can
 * render top-5 + Other and the share-of-margin line can be derived.
 * Top-5 set is computed across the ACTUAL months in the window (skip
 * forecast for stability) so colors don't reshuffle when scrubbing.
 * Heavy fan-out: projects × months. Tagged `expensive` and capped at
 * 24 months. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "customer_rentability_series", "expensive");

    const { searchParams } = new URL(req.url);
    const from_raw = searchParams.get("from_month") ?? "";
    const to_raw = searchParams.get("to_month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(from_raw) || !/^\d{4}-\d{2}$/.test(to_raw)) {
      throw Validation("from_month and to_month must be YYYY-MM");
    }
    const from_month = firstOfMonth(`${from_raw}-01`);
    const to_month = firstOfMonth(`${to_raw}-01`);
    if (to_month < from_month) {
      throw Validation("to_month must be >= from_month");
    }
    const months: string[] = [];
    let cur = from_month;
    while (cur <= to_month && months.length < 24) {
      months.push(cur.slice(0, 7));
      cur = addMonths(cur, 1);
    }

    const today = new Date().toISOString().slice(0, 10);
    // Bounded month fan-out: each month is internally parallel already;
    // running all 16 at once would just flood the pg pool queue.
    const perMonth = await mapWithConcurrency(months, 4, async (monthYm) => ({
      month: monthYm,
      is_forecast: `${monthYm}-01` > today,
      aggregates: await computeCustomerMonthlyAggregates(monthYm),
    }));

    // Stable top-5 across the window — sum each customer's margin over
    // the ACTUAL months only (forecasts are projections; including them
    // would let a forecast spike reorder colors). Customers with a
    // negative aggregate margin don't qualify as "top" — they're a
    // concentration of LOSS, not of contribution.
    const aggMargin = new Map<number, { name: string; sum: number }>();
    for (const p of perMonth) {
      if (p.is_forecast) continue;
      for (const c of p.aggregates) {
        const cur = aggMargin.get(c.customer_id) ?? {
          name: c.customer_name,
          sum: 0,
        };
        cur.sum += Number(c.margin);
        aggMargin.set(c.customer_id, cur);
      }
    }
    const top_customers = Array.from(aggMargin, ([customer_id, v]) => ({
      customer_id,
      customer_name: v.name,
      window_margin_sum: v.sum,
    }))
      .filter((x) => x.window_margin_sum > 0)
      .sort((a, b) => b.window_margin_sum - a.window_margin_sum)
      .slice(0, 5)
      .map((x) => ({
        customer_id: x.customer_id,
        customer_name: x.customer_name,
      }));

    // Per-month "top-5 share" = top-5 margin / sum of POSITIVE customer
    // margin (matches the concentration math, where negative
    // contributors are excluded). Returned alongside the raw points
    // so the chart's right-axis line is a server-truthed value, not
    // a client recomputation.
    const points = perMonth.map((p) => {
      const positive = p.aggregates.filter((c) => Number(c.margin) > 0);
      const totalPos = positive.reduce((s, c) => s + Number(c.margin), 0);
      const top5Set = new Set(top_customers.map((t) => t.customer_id));
      const top5Sum = positive
        .filter((c) => top5Set.has(c.customer_id))
        .reduce((s, c) => s + Number(c.margin), 0);
      const top_5_share_pct =
        totalPos > 0 ? ((top5Sum / totalPos) * 100).toFixed(2) : null;
      return {
        month: p.month,
        is_forecast: p.is_forecast,
        top_5_share_pct,
        customers: p.aggregates.map((c) => ({
          customer_id: c.customer_id,
          customer_name: c.customer_name,
          margin: c.margin,
          revenue: c.revenue,
        })),
      };
    });

    await audit(ctx, {
      action: "view_customer_rentability_series",
      target_type: "report",
      target_id: "customer_rentability",
    });

    return { points, top_customers };
  });
}
