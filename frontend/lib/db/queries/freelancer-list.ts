/** Shared freelancer-list query used by:
 *   - the `/api/freelancers` GET route handler
 *   - server-side prefetch on the freelancers page (Phase D)
 */
import { asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { freelancer } from "../schema";

export type FreelancerListItem = {
  freelancer_id: number;
  name: string;
  daily_cost_eur: string;
  status: string;
  contact_email: string | null;
  active_assigns: number;
};

export async function listFreelancers(opts: { status?: string } = {}): Promise<
  FreelancerListItem[]
> {
  const activeAssigns = sql<number>`(
    SELECT COUNT(*)::int FROM assignment a
    WHERE a.freelancer_id = freelancer.freelancer_id
      AND a.start_date <= CURRENT_DATE
      AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
  )`.as("active_assigns");

  const base = db
    .select({
      freelancer_id: freelancer.freelancer_id,
      name: freelancer.name,
      daily_cost_eur: freelancer.daily_cost_eur,
      status: freelancer.status,
      contact_email: freelancer.contact_email,
      active_assigns: activeAssigns,
    })
    .from(freelancer)
    .orderBy(asc(freelancer.name));

  return opts.status
    ? await base.where(eq(freelancer.status, opts.status))
    : await base;
}
