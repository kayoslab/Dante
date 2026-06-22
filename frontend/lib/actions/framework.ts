"use server";

/** Phase C.2 — Framework + framework_rate mutations as Server Actions.
 *
 * Ports `src/dante/api/service/framework.py` to TypeScript. Six
 * actions total: framework create/update/delete + rate add/update/delete.
 *
 * Rate `valid_from`s are ISO date strings (`YYYY-MM-DD`) — the schema column
 * is `date({ mode: "string" })`, so values pass through unchanged.
 */
import { z } from "zod";

import {
  countFrameworkChildren,
  customerExistsForFramework,
  defaultFrameworkRateValidFrom,
  deleteFrameworkCascading,
  deleteFrameworkRate,
  findFrameworkByCustomerAndName,
  findFrameworkRate,
  frameworkExists,
  getFrameworkDetail,
  getFrameworkName,
  insertFramework,
  insertFrameworkRate,
  updateFramework,
  updateFrameworkRate,
  type FrameworkDetail,
  type FrameworkRate,
} from "@/lib/db/queries/framework";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const CreateFrameworkSchema = z.object({
  customer_id: z.number().int(),
  name: z.string().min(1).max(200),
  start_date: IsoDate.nullable().optional(),
  end_date: IsoDate.nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateFrameworkSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  start_date: IsoDate.nullable().optional(),
  end_date: IsoDate.nullable().optional(),
  notes: z.string().nullable().optional(),
});

const RateCreateSchema = z.object({
  profile: z.string().min(1).max(120),
  daily_rate_eur: z.number().positive(),
  valid_from: IsoDate.nullable().optional(),
});

const RateUpdateSchema = z.object({
  daily_rate_eur: z.number().positive(),
});

// ----------------------------------------------------------------------------
// Framework CRUD
// ----------------------------------------------------------------------------

export async function createFrameworkAction(
  input: unknown,
): Promise<ActionResult<FrameworkDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateFrameworkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await customerExistsForFramework(parsed.data.customer_id))) {
    return err("not_found", `customer not found: ${parsed.data.customer_id}`);
  }

  const name = parsed.data.name.trim();
  if (!name) return err("conflict", "framework name cannot be empty");

  const dup = await findFrameworkByCustomerAndName(
    parsed.data.customer_id,
    name,
  );
  if (dup !== null) {
    return err(
      "conflict",
      `framework '${name}' already exists for this customer`,
    );
  }

  const framework_id = await insertFramework({
    customer_id: parsed.data.customer_id,
    name,
    start_date: parsed.data.start_date ?? null,
    end_date: parsed.data.end_date ?? null,
    notes: parsed.data.notes ?? null,
  });

  const detail = await getFrameworkDetail(framework_id);
  if (!detail) return err("internal_error", "created framework not found");
  return ok(detail);
}

export async function updateFrameworkAction(
  framework_id: number,
  input: unknown,
): Promise<ActionResult<FrameworkDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(framework_id)) {
    return err("validation_error", `invalid framework id: ${framework_id}`);
  }
  const parsed = UpdateFrameworkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await frameworkExists(framework_id))) {
    return err("not_found", `framework not found: ${framework_id}`);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) {
    updates.name = parsed.data.name.trim();
  }
  if (parsed.data.start_date !== undefined) {
    updates.start_date = parsed.data.start_date;
  }
  if (parsed.data.end_date !== undefined) {
    updates.end_date = parsed.data.end_date;
  }
  if (parsed.data.notes !== undefined) {
    updates.notes = parsed.data.notes;
  }
  if (Object.keys(updates).length === 0) {
    const d = await getFrameworkDetail(framework_id);
    if (!d) return err("not_found", `framework not found: ${framework_id}`);
    return ok(d);
  }

  try {
    await updateFramework(framework_id, updates);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", "framework name already exists for this customer");
    }
    throw e;
  }

  const detail = await getFrameworkDetail(framework_id);
  if (!detail) return err("not_found", `framework not found: ${framework_id}`);
  return ok(detail);
}

export async function deleteFrameworkAction(
  framework_id: number,
  force = false,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(framework_id)) {
    return err("validation_error", `invalid framework id: ${framework_id}`);
  }

  const name = await getFrameworkName(framework_id);
  if (name === null) {
    return err("not_found", `framework not found: ${framework_id}`);
  }

  const { n_rates, n_proj } = await countFrameworkChildren(framework_id);
  if ((n_rates > 0 || n_proj > 0) && !force) {
    return err(
      "has_children",
      `framework '${name}' has ${n_rates} rate(s) and ${n_proj} project(s) linked. Pass force=true to cascade (rates removed, projects unlinked).`,
    );
  }

  await deleteFrameworkCascading(framework_id, force);
  return ok(null);
}

// ----------------------------------------------------------------------------
// Rates
// ----------------------------------------------------------------------------

export async function addFrameworkRateAction(
  framework_id: number,
  input: unknown,
): Promise<ActionResult<FrameworkRate>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(framework_id)) {
    return err("validation_error", `invalid framework id: ${framework_id}`);
  }
  const parsed = RateCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await frameworkExists(framework_id))) {
    return err("not_found", `framework not found: ${framework_id}`);
  }

  const profile = parsed.data.profile.trim();
  if (!profile) return err("conflict", "rate profile cannot be empty");
  const valid_from =
    parsed.data.valid_from ?? (await defaultFrameworkRateValidFrom(framework_id));

  const dup = await findFrameworkRate(framework_id, profile, valid_from);
  if (dup !== null) {
    return err(
      "conflict",
      `rate for profile '${profile}' on this framework effective ${valid_from} already exists (€${dup.daily_rate_eur}/day)`,
    );
  }

  // numeric column accepts string; pass the JS number stringified to preserve scale
  await insertFrameworkRate({
    framework_id,
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });

  return ok({
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });
}

export async function updateFrameworkRateAction(
  framework_id: number,
  profile: string,
  valid_from: string,
  input: unknown,
): Promise<ActionResult<FrameworkRate>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(framework_id)) {
    return err("validation_error", `invalid framework id: ${framework_id}`);
  }
  if (!IsoDate.safeParse(valid_from).success) {
    return err("validation_error", "valid_from must be YYYY-MM-DD");
  }
  const parsed = RateUpdateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const existing = await findFrameworkRate(framework_id, profile, valid_from);
  if (existing === null) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on framework ${framework_id} with valid_from ${valid_from}`,
    );
  }

  await updateFrameworkRate(
    framework_id,
    profile,
    valid_from,
    String(parsed.data.daily_rate_eur),
  );
  return ok({
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });
}

export async function deleteFrameworkRateAction(
  framework_id: number,
  profile: string,
  valid_from: string,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(framework_id)) {
    return err("validation_error", `invalid framework id: ${framework_id}`);
  }
  if (!IsoDate.safeParse(valid_from).success) {
    return err("validation_error", "valid_from must be YYYY-MM-DD");
  }
  const existing = await findFrameworkRate(framework_id, profile, valid_from);
  if (existing === null) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on framework ${framework_id} with valid_from ${valid_from}`,
    );
  }
  await deleteFrameworkRate(framework_id, profile, valid_from);
  return ok(null);
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}
