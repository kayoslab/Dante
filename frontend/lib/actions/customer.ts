"use server";

import { z } from "zod";

import {
  countCustomerChildren,
  customerExists,
  deleteCustomerCascading,
  findCustomerIdByName,
  getCustomerDetail,
  getCustomerName,
  insertCustomer,
  updateCustomer,
  type CustomerDetail,
} from "@/lib/db/queries/customer";

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

  if ((await findCustomerIdByName(name)) !== null) {
    return err("conflict", `customer already exists: ${name}`);
  }

  const customer_id = await insertCustomer({
    name,
    notes: parsed.data.notes ?? null,
  });

  const detail = await getCustomerDetail(customer_id);
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

  if (!(await customerExists(customer_id))) {
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

  try {
    await updateCustomer(customer_id, updates);
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

  const name = await getCustomerName(customer_id);
  if (name === null) {
    return err("not_found", `customer not found: ${customer_id}`);
  }

  const { n_fw, n_pr } = await countCustomerChildren(customer_id);
  if ((n_fw > 0 || n_pr > 0) && !force) {
    return err(
      "has_children",
      `customer '${name}' has ${n_fw} framework(s) and ${n_pr} project(s). Pass force=true to cascade.`,
    );
  }

  await deleteCustomerCascading(customer_id, force);
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
