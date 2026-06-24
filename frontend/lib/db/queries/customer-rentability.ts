import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import { fmt } from "../_monthly-helpers";
import { computeProjectMonthlyRows } from "./portfolio";

/** Per-customer monthly aggregates — pivots the project P&L engine
 * (`computeProjectMonthlyRows`) by `customer_id`. The customer-
 * rentability report renders these as the Pareto table and stacks
 * them into the trend chart. */
export type CustomerMonthlyAggregate = {
  customer_id: number;
  customer_name: string;
  n_projects: number;
  revenue: string;
  cost: string;
  margin: string;
  /** revenue > 0 → margin/revenue × 100, else null. */
  margin_pct: string | null;
};

export async function computeCustomerMonthlyAggregates(
  monthYm: string,
): Promise<CustomerMonthlyAggregate[]> {
  const { rows: projectRows } = await computeProjectMonthlyRows(monthYm);

  type Acc = {
    customer_id: number;
    customer_name: string;
    n_projects: number;
    revenue: Decimal;
    cost: Decimal;
  };
  const byCustomer = new Map<number, Acc>();

  for (const r of projectRows) {
    const acc = byCustomer.get(r.customer_id) ?? {
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      n_projects: 0,
      revenue: new Decimal(0),
      cost: new Decimal(0),
    };
    acc.n_projects += 1;
    if (r.revenue !== null) acc.revenue = acc.revenue.add(r.revenue);
    acc.cost = acc.cost.add(r.cost);
    byCustomer.set(r.customer_id, acc);
  }

  return Array.from(byCustomer.values()).map((acc) => {
    const margin = acc.revenue.sub(acc.cost);
    const margin_pct = acc.revenue.gt(0)
      ? margin.div(acc.revenue).mul(100)
      : null;
    return {
      customer_id: acc.customer_id,
      customer_name: acc.customer_name,
      n_projects: acc.n_projects,
      revenue: fmt(acc.revenue, 2),
      cost: fmt(acc.cost, 2),
      margin: fmt(margin, 2),
      margin_pct: margin_pct === null ? null : fmt(margin_pct, 2),
    };
  });
}

// ---------------------------------------------------------------------------
// Concentration metrics
// ---------------------------------------------------------------------------

export type CustomerConcentration = {
  /** Customers with strictly positive margin — concentration math
   * excludes negative contributors (losing them would reduce risk,
   * not concentrate it). */
  n_positive_contributors: number;
  /** Sum of all positive margins; the denominator for share calc. */
  total_positive_margin: string;
  /** Largest single customer's share of positive margin, %. */
  top_1_share_pct: string;
  /** Sum of top-5 customers' shares, %. */
  top_5_share_pct: string;
  /** How many customers individually carry ≥10% of positive margin. */
  n_customers_above_10pct: number;
  /** Herfindahl-Hirschman Index — sum of squared customer shares, on
   * a 0-10000 scale. <1500 = diversified; 1500-2500 = moderate;
   * >2500 = high concentration. Same thresholds antitrust regulators
   * apply, so it's a defensible board-meeting number. */
  hhi: string;
};

export function computeCustomerConcentration(
  customers: CustomerMonthlyAggregate[],
): CustomerConcentration | null {
  const positive = customers
    .map((c) => ({ name: c.customer_name, margin: Number(c.margin) }))
    .filter((c) => c.margin > 0);
  if (positive.length === 0) return null;

  const total = positive.reduce((s, c) => s + c.margin, 0);
  const shares = positive
    .map((c) => (c.margin / total) * 100)
    .sort((a, b) => b - a);

  const top1 = shares[0] ?? 0;
  const top5 = shares.slice(0, 5).reduce((s, x) => s + x, 0);
  const nAbove10 = shares.filter((s) => s >= 10).length;
  const hhi = shares.reduce((s, x) => s + x * x, 0);

  return {
    n_positive_contributors: positive.length,
    total_positive_margin: total.toFixed(2),
    top_1_share_pct: top1.toFixed(2),
    top_5_share_pct: top5.toFixed(2),
    n_customers_above_10pct: nAbove10,
    hhi: hhi.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Concentration-at-risk: customers whose biggest project is winding down
// ---------------------------------------------------------------------------

export type EndingProjectByCustomer = {
  customer_id: number;
  customer_name: string;
  project_id: number;
  project_name: string;
  project_ends_date: string;
};

/** Active projects whose latest assignment end_date falls inside the
 * window AND have no continuing assignment past it — i.e. the project
 * is fully winding down. Joined with customer so the panel can show
 * which customers are losing the most committed work. */
export async function listEndingProjectsByCustomer(
  from_date: string,
  to_date: string,
): Promise<EndingProjectByCustomer[]> {
  const r = await db.execute(sql`
    SELECT
      c.customer_id,
      c.name AS customer_name,
      p.project_id,
      p.name AS project_name,
      MAX(a.end_date) AS project_ends_date
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    JOIN assignment a ON a.project_id = p.project_id
    WHERE p.status = 'active'
      AND a.end_date IS NOT NULL
    GROUP BY c.customer_id, c.name, p.project_id, p.name
    HAVING MAX(a.end_date) BETWEEN ${from_date}::date AND ${to_date}::date
       AND NOT EXISTS (
         SELECT 1 FROM assignment a2
         WHERE a2.project_id = p.project_id
           AND (a2.end_date IS NULL OR a2.end_date > ${to_date}::date)
       )
    ORDER BY MAX(a.end_date) ASC, c.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    customer_id: Number(row.customer_id),
    customer_name: row.customer_name as string,
    project_id: Number(row.project_id),
    project_name: row.project_name as string,
    project_ends_date: row.project_ends_date as string,
  }));
}
