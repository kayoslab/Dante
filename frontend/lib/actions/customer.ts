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
import { audit } from "@/lib/auth/audit";

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
  const ctx = auth.ctx;

  const parsed = CreateCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const name = parsed.data.name.trim();
  if (!name) {
    await audit(ctx, {
      action: "customer_created_denied",
      target_type: "customer",
      target_id: null,
    });
    return err("conflict", "customer name cannot be empty");
  }

  if ((await findCustomerIdByName(name)) !== null) {
    await audit(ctx, {
      action: "customer_created_denied",
      target_type: "customer",
      target_id: null,
    });
    return err("conflict", `customer already exists: ${name}`);
  }

  const customer_id = await insertCustomer({
    name,
    notes: parsed.data.notes ?? null,
  });

  const detail = await getCustomerDetail(customer_id);
  if (!detail) return err("internal_error", "created customer not found");

  await audit(ctx, {
    action: "customer_created",
    target_type: "customer",
    target_id: customer_id,
  });

  return ok(detail);
}

export async function updateCustomerAction(
  customer_id: number,
  input: unknown,
): Promise<ActionResult<CustomerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const parsed = UpdateCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await customerExists(customer_id))) {
    await audit(ctx, {
      action: "customer_updated_denied",
      target_type: "customer",
      target_id: customer_id,
    });
    return err("not_found", `customer not found: ${customer_id}`);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) {
    const cleaned = parsed.data.name.trim();
    if (!cleaned) {
      await audit(ctx, {
        action: "customer_updated_denied",
        target_type: "customer",
        target_id: customer_id,
      });
      return err("conflict", "customer name cannot be empty");
    }
    updates.name = cleaned;
  }
  if (parsed.data.notes !== undefined) {
    updates.notes = parsed.data.notes;
  }

  if (Object.keys(updates).length === 0) {
    const d = await getCustomerDetail(customer_id);
    if (!d) {
      await audit(ctx, {
        action: "customer_updated_denied",
        target_type: "customer",
        target_id: customer_id,
      });
      return err("not_found", `customer not found: ${customer_id}`);
    }
    return ok(d);
  }

  try {
    await updateCustomer(customer_id, updates);
  } catch (e) {
    if (isUniqueViolation(e)) {
      await audit(ctx, {
        action: "customer_updated_denied",
        target_type: "customer",
        target_id: customer_id,
      });
      return err(
        "conflict",
        `customer name already exists: ${updates.name as string}`,
      );
    }
    throw e;
  }

  const detail = await getCustomerDetail(customer_id);
  if (!detail) {
    await audit(ctx, {
      action: "customer_updated_denied",
      target_type: "customer",
      target_id: customer_id,
    });
    return err("not_found", `customer not found: ${customer_id}`);
  }

  await audit(ctx, {
    action: "customer_updated",
    target_type: "customer",
    target_id: customer_id,
  });

  return ok(detail);
}

export async function deleteCustomerAction(
  customer_id: number,
  force = false,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }

  const name = await getCustomerName(customer_id);
  if (name === null) {
    await audit(ctx, {
      action: "customer_deleted_denied",
      target_type: "customer",
      target_id: customer_id,
    });
    return err("not_found", `customer not found: ${customer_id}`);
  }

  const { n_fw, n_pr } = await countCustomerChildren(customer_id);
  if ((n_fw > 0 || n_pr > 0) && !force) {
    await audit(ctx, {
      action: "customer_deleted_denied",
      target_type: "customer",
      target_id: customer_id,
    });
    return err(
      "has_children",
      `customer '${name}' has ${n_fw} framework(s) and ${n_pr} project(s). Pass force=true to cascade.`,
    );
  }

  // Audit BEFORE deleting — the audit_log FK may set target id to null
  // on cascade; capture the id while the row still exists.
  await audit(ctx, {
    action: "customer_deleted",
    target_type: "customer",
    target_id: customer_id,
  });

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
