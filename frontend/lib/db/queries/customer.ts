import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";

import { escapeLikePattern } from "../../agent/_validation";

import { db } from "../client";
import {
  assignment,
  aworkCompany,
  externalLink,
  customer,
  frameworkAgreement,
  frameworkRate,
  project,
  projectRate,
} from "../schema";

export type CustomerDetail = {
  customer_id: number;
  name: string;
  notes: string | null;
  created_at: string;
  frameworks: Array<{
    framework_id: number;
    customer_id: number;
    name: string;
    start_date: string | null;
    end_date: string | null;
  }>;
  projects: Array<{
    project_id: number;
    customer_id: number;
    name: string;
    billing_model: string;
    status: string;
  }>;
};

export async function getCustomerDetail(
  customer_id: number,
): Promise<CustomerDetail | null> {
  const [row] = await db
    .select({
      customer_id: customer.customer_id,
      name: customer.name,
      notes: customer.notes,
      created_at: customer.created_at,
    })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  if (!row) return null;

  const frameworks = await db
    .select({
      framework_id: frameworkAgreement.framework_id,
      customer_id: frameworkAgreement.customer_id,
      name: frameworkAgreement.name,
      start_date: frameworkAgreement.start_date,
      end_date: frameworkAgreement.end_date,
    })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.customer_id, customer_id))
    .orderBy(sql`${frameworkAgreement.start_date} DESC NULLS LAST`);

  const projects = await db
    .select({
      project_id: project.project_id,
      customer_id: project.customer_id,
      name: project.name,
      billing_model: project.billing_model,
      status: project.status,
    })
    .from(project)
    .where(eq(project.customer_id, customer_id))
    .orderBy(asc(project.status), asc(project.name));

  return {
    customer_id: row.customer_id,
    name: row.name,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    frameworks,
    projects,
  };
}

export type CustomerAworkLinkRow = {
  awork_company_id: unknown;
  name: unknown;
  is_external: unknown;
  projects_count: unknown;
  projects_in_progress_count: unknown;
  mapped_to_customer_id: number;
  mapped_to_customer_name: null;
};

export async function getCustomerAworkLink(
  customer_id: number,
): Promise<CustomerAworkLinkRow | null> {
  const r = await db.execute(sql`
    SELECT aco.awork_company_id, aco.name, aco.is_external,
           aco.projects_count, aco.projects_in_progress_count
    FROM awork_company_link link
    JOIN awork_company aco
      ON aco.awork_company_id = link.awork_company_id
    WHERE link.customer_id = ${customer_id}
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    awork_company_id: row.awork_company_id,
    name: row.name,
    is_external: row.is_external,
    projects_count: row.projects_count,
    projects_in_progress_count: row.projects_in_progress_count,
    mapped_to_customer_id: customer_id,
    mapped_to_customer_name: null,
  };
}

// ----------------------------------------------------------------------------
// Mutations — used by `lib/actions/customer.ts`.
// ----------------------------------------------------------------------------

/** Lookup an existing customer by exact name. Returns the matching
 * `customer_id` or `null`. Used by `createCustomerAction` to short-circuit
 * a duplicate insert with a friendlier conflict message than the
 * Postgres unique-violation. */
/** Fuzzy ILIKE-substring lookup, ordered by name length so shorter
 * matches surface first (a search for "Acme" prefers "Acme GmbH" over
 * "Acme Holding Europe AG"). Used by the agent's `matchCustomers`
 * endpoint to dedupe PDF-extracted names against existing customers.
 * Switch to `pg_trgm.similarity()` once the extension is enabled. */
export async function matchCustomersByName(
  q: string,
  limit: number,
): Promise<Array<{ customer_id: number; name: string }>> {
  // Escape `%` / `_` / `\` so a caller can't turn a fuzzy lookup into
  // an unrestricted scan with q="%".
  const pattern = `%${escapeLikePattern(q)}%`;
  return db
    .select({ customer_id: customer.customer_id, name: customer.name })
    .from(customer)
    .where(ilike(customer.name, pattern))
    .orderBy(sql`length(${customer.name})`)
    .limit(limit);
}

export async function findCustomerIdByName(
  name: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.name, name));
  return rows[0]?.id ?? null;
}

/** Existence probe for a `customer_id`. */
export async function customerExists(customer_id: number): Promise<boolean> {
  const rows = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  return rows.length > 0;
}

/** Fetch a customer's name without the full detail payload — used to
 * compose the cascade-delete error message. Returns `null` when missing. */
export async function getCustomerName(
  customer_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ name: customer.name })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  return row?.name ?? null;
}

/** Insert a fresh customer; returns the newly minted `customer_id`. */
export async function insertCustomer(args: {
  name: string;
  notes: string | null;
}): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(customer)
    .values({
      name: args.name,
      notes: args.notes,
      created_at: now,
      updated_at: now,
    })
    .returning({ customer_id: customer.customer_id });
  return row.customer_id;
}

/** Apply a partial update; caller composes the `updates` dict so we keep
 * the "only-touched-fields" semantics from the action. `updated_at` is
 * stamped here so callers can't forget it. */
export async function updateCustomer(
  customer_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(customer)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(customer.customer_id, customer_id));
}

/** Count of frameworks + projects linked to a customer — used by the
 * cascade-delete guard to decide whether to require `force=true`. */
export async function countCustomerChildren(
  customer_id: number,
): Promise<{ n_fw: number; n_pr: number }> {
  const [row] = await db
    .select({
      n_fw: sql<number>`(SELECT COUNT(*)::int FROM ${frameworkAgreement} WHERE ${frameworkAgreement.customer_id} = ${customer_id})`,
      n_pr: sql<number>`(SELECT COUNT(*)::int FROM ${project} WHERE ${project.customer_id} = ${customer_id})`,
    })
    .from(sql`(SELECT 1) AS dummy`);
  return { n_fw: Number(row.n_fw), n_pr: Number(row.n_pr) };
}

/** Cascade-remove every dependent row for a customer (assignments,
 * project rates, projects, framework rates, frameworks) and finally
 * the customer row itself. Order matches the FK chain so the final
 * `customer` delete sees no children.
 *
 * Called only when the action has already determined the caller passed
 * `force=true` (or no children exist), so this function does no
 * additional gating. */
export async function deleteCustomerCascading(
  customer_id: number,
  force: boolean,
): Promise<void> {
  if (force) {
    // Order: assignments → project_rate → project → framework_rate → framework → customer
    const projectIds = (
      await db
        .select({ id: project.project_id })
        .from(project)
        .where(eq(project.customer_id, customer_id))
    ).map((p) => p.id);
    if (projectIds.length > 0) {
      await db
        .delete(assignment)
        .where(inArray(assignment.project_id, projectIds));
      await db
        .delete(projectRate)
        .where(inArray(projectRate.project_id, projectIds));
      await db.delete(project).where(eq(project.customer_id, customer_id));
    }
    const fwIds = (
      await db
        .select({ id: frameworkAgreement.framework_id })
        .from(frameworkAgreement)
        .where(eq(frameworkAgreement.customer_id, customer_id))
    ).map((f) => f.id);
    if (fwIds.length > 0) {
      await db
        .delete(frameworkRate)
        .where(inArray(frameworkRate.framework_id, fwIds));
      await db
        .delete(frameworkAgreement)
        .where(eq(frameworkAgreement.customer_id, customer_id));
    }
  }

  await db.delete(customer).where(eq(customer.customer_id, customer_id));
}

// ----------------------------------------------------------------------------
// awork_company_link write-side helpers.
// ----------------------------------------------------------------------------

/** Look up an awork company's name — `null` when the upstream awork
 * company row does not exist. */
export async function getAworkCompanyName(
  awork_company_id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: aworkCompany.name })
    .from(aworkCompany)
    .where(eq(aworkCompany.awork_company_id, awork_company_id));
  return row?.name ?? null;
}

/** Is this awork company already linked? Returns the linked
 * `customer_id` or `null`. */
export async function getAworkCompanyLinkCustomerId(
  awork_company_id: string,
): Promise<number | null> {
  const [row] = await db
    .select({ customer_id: externalLink.dante_id })
    .from(externalLink)
    .where(
      and(
        eq(externalLink.integration_slug, "awork"),
        eq(externalLink.entity_type, "company"),
        eq(externalLink.external_id, awork_company_id),
      ),
    );
  return row?.customer_id ?? null;
}

export async function insertAworkCompanyLink(input: {
  awork_company_id: string;
  customer_id: number;
}): Promise<void> {
  await db.insert(externalLink).values({
    integration_slug: "awork",
    entity_type: "company",
    external_id: input.awork_company_id,
    dante_type: "customer",
    dante_id: input.customer_id,
    origin: "manual",
    mapped_at: new Date(),
  });
}

export async function deleteAworkCompanyLink(
  customer_id: number,
  awork_company_id: string,
): Promise<number> {
  const rows = await db
    .delete(externalLink)
    .where(
      and(
        eq(externalLink.integration_slug, "awork"),
        eq(externalLink.entity_type, "company"),
        eq(externalLink.external_id, awork_company_id),
        eq(externalLink.dante_id, customer_id),
      ),
    )
    .returning({ id: externalLink.external_id });
  return rows.length;
}
