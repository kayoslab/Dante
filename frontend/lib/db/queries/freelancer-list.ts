/** Shared freelancer-list query used by:
 *   - the `/api/freelancers` GET route handler
 *   - server-side prefetch on the freelancers page (Phase D)
 */
import { asc, eq, ilike, sql } from "drizzle-orm";

import { escapeLikePattern } from "../../agent/_validation";
import { db } from "../client";
import { freelancer } from "../schema";

/** Fuzzy ILIKE-substring lookup for the agent's `matchFreelancers`
 * endpoint. Used by the freelancer-bill workflow to map an extracted
 * name to a `freelancer_id`. */
export async function matchFreelancersByName(
  q: string,
  limit: number,
): Promise<
  Array<{
    freelancer_id: number;
    name: string;
    status: string;
    contact_email: string | null;
  }>
> {
  // Escape `%` / `_` / `\` so a caller can't turn a fuzzy lookup into
  // an unrestricted scan with q="%".
  const pattern = `%${escapeLikePattern(q)}%`;
  return db
    .select({
      freelancer_id: freelancer.freelancer_id,
      name: freelancer.name,
      status: freelancer.status,
      contact_email: freelancer.contact_email,
    })
    .from(freelancer)
    .where(ilike(freelancer.name, pattern))
    .orderBy(sql`length(${freelancer.name})`)
    .limit(limit);
}

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
