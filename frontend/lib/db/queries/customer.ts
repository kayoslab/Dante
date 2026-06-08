import { asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { customer, frameworkAgreement, project } from "../schema";

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
