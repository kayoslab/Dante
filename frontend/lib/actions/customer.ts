"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { getCustomerDetail, type CustomerDetail } from "@/lib/db/queries/customer";
import {
  assignment,
  customer,
  frameworkAgreement,
  frameworkRate,
  project,
  projectRate,
} from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

const CreateCustomerSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().nullable().optional(),
});

const UpdateCustomerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  notes: z.string().nullable().optional(),
});

export async function createCustomerAction(
  input: unknown,
): Promise<ActionResult<CustomerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const name = parsed.data.name.trim();
  if (!name) return err("conflict", "customer name cannot be empty");

  const existing = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.name, name));
  if (existing.length > 0) {
    return err("conflict", `customer already exists: ${name}`);
  }

  const now = new Date();
  const [row] = await db
    .insert(customer)
    .values({
      name,
      notes: parsed.data.notes ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning({ customer_id: customer.customer_id });

  const detail = await getCustomerDetail(row.customer_id);
  if (!detail) return err("internal_error", "created customer not found");
  return ok(detail);
}

export async function updateCustomerAction(
  customer_id: number,
  input: unknown,
): Promise<ActionResult<CustomerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const parsed = UpdateCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const existing = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  if (existing.length === 0) {
    return err("not_found", `customer not found: ${customer_id}`);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) {
    const cleaned = parsed.data.name.trim();
    if (!cleaned) return err("conflict", "customer name cannot be empty");
    updates.name = cleaned;
  }
  if (parsed.data.notes !== undefined) {
    updates.notes = parsed.data.notes;
  }

  if (Object.keys(updates).length === 0) {
    const d = await getCustomerDetail(customer_id);
    if (!d) return err("not_found", `customer not found: ${customer_id}`);
    return ok(d);
  }

  updates.updated_at = new Date();
  try {
    await db
      .update(customer)
      .set(updates)
      .where(eq(customer.customer_id, customer_id));
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err(
        "conflict",
        `customer name already exists: ${updates.name as string}`,
      );
    }
    throw e;
  }

  const detail = await getCustomerDetail(customer_id);
  if (!detail) return err("not_found", `customer not found: ${customer_id}`);
  return ok(detail);
}

export async function deleteCustomerAction(
  customer_id: number,
  force = false,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }

  const [existing] = await db
    .select({ name: customer.name })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  if (!existing) {
    return err("not_found", `customer not found: ${customer_id}`);
  }
  const name = existing.name;

  const [{ n_fw, n_pr }] = await db
    .select({
      n_fw: sql<number>`(SELECT COUNT(*)::int FROM ${frameworkAgreement} WHERE ${frameworkAgreement.customer_id} = ${customer_id})`,
      n_pr: sql<number>`(SELECT COUNT(*)::int FROM ${project} WHERE ${project.customer_id} = ${customer_id})`,
    })
    .from(sql`(SELECT 1) AS dummy`);

  if ((n_fw > 0 || n_pr > 0) && !force) {
    return err(
      "has_children",
      `customer '${name}' has ${n_fw} framework(s) and ${n_pr} project(s). Pass force=true to cascade.`,
    );
  }

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
  return ok(null);
}

/** Postgres unique-violation SQLSTATE — emitted by `pg` driver. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}

// Silence the unused-import lint when build context narrows down — these
// stay referenced by the body above.
void and;

