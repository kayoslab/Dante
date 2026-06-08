import { asc, eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import {
  customer,
  frameworkAgreement,
  project,
} from "@/lib/db/schema";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const customer_id = Number(rawId);
    if (!Number.isInteger(customer_id)) {
      throw Validation(`invalid customer id: ${rawId}`);
    }

    const [row] = await db
      .select({
        customer_id: customer.customer_id,
        name: customer.name,
        notes: customer.notes,
        created_at: customer.created_at,
      })
      .from(customer)
      .where(eq(customer.customer_id, customer_id));
    if (!row) throw NotFound(`customer not found: ${customer_id}`);

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
  });
}
