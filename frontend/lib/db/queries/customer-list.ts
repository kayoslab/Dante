/** Shared customer-list query used by:
 *   - the `/api/customers` GET route handler (Phase B)
 *   - server-side prefetch on the customers page (Phase D)
 *
 * Same SQL, same shape. Single source of truth so the SSR'd payload and
 * the client-side `useCustomers` cache hit on bit-identical data.
 */
import { asc, desc, sql } from "drizzle-orm";

import { db } from "../client";
import { customer, frameworkAgreement, project } from "../schema";

export type CustomerListItem = {
  customer_id: number;
  name: string;
  n_frameworks: number;
  n_projects: number;
};

const VALID_SORT = new Set([
  "name",
  "n_projects",
  "n_frameworks",
  "customer_id",
]);

export async function listCustomers(opts: {
  sort?: string;
  order?: string;
} = {}): Promise<CustomerListItem[]> {
  const sortRaw = opts.sort ?? "name";
  const sortParam = VALID_SORT.has(sortRaw) ? sortRaw : "name";
  const direction =
    (opts.order ?? "asc").toLowerCase() === "desc" ? desc : asc;

  const nFrameworks = sql<number>`(
    SELECT COUNT(*)::int FROM framework_agreement
    WHERE framework_agreement.customer_id = customer.customer_id
  )`.as("n_frameworks");
  const nProjects = sql<number>`(
    SELECT COUNT(*)::int FROM project
    WHERE project.customer_id = customer.customer_id
  )`.as("n_projects");

  const rows = await db
    .select({
      customer_id: customer.customer_id,
      name: customer.name,
      n_frameworks: nFrameworks,
      n_projects: nProjects,
    })
    .from(customer)
    .orderBy(
      sortParam === "n_projects"
        ? direction(nProjects)
        : sortParam === "n_frameworks"
          ? direction(nFrameworks)
          : sortParam === "customer_id"
            ? direction(customer.customer_id)
            : direction(customer.name),
    );

  return rows;
  void frameworkAgreement;
  void project;
}
