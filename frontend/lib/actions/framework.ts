"use server";

/** Phase C.2 — Framework + framework_rate mutations as Server Actions.
 *
 * Ports `src/dante/api/service/framework.py` to TypeScript. Six
 * actions total: framework create/update/delete + rate add/update/delete.
 *
 * Rate `valid_from`s are ISO date strings (`YYYY-MM-DD`) — the schema column
 * is `date({ mode: "string" })`, so values pass through unchanged.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  getFrameworkDetail,
  type FrameworkDetail,
  type FrameworkRate,
} from "@/lib/db/queries/framework";
import {
  customer,
  frameworkAgreement,
  frameworkRate,
  project,
} from "@/lib/db/schema";

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

async function ensureCustomer(customer_id: number): Promise<boolean> {
  const r = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  return r.length > 0;
}

export async function createFrameworkAction(
  input: unknown,
): Promise<ActionResult<FrameworkDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateFrameworkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await ensureCustomer(parsed.data.customer_id))) {
    return err("not_found", `customer not found: ${parsed.data.customer_id}`);
  }

  const name = parsed.data.name.trim();
  if (!name) return err("conflict", "framework name cannot be empty");

  const dup = await db
    .select({ id: frameworkAgreement.framework_id })
    .from(frameworkAgreement)
    .where(
      and(
        eq(frameworkAgreement.customer_id, parsed.data.customer_id),
        eq(frameworkAgreement.name, name),
      ),
    );
  if (dup.length > 0) {
    return err(
      "conflict",
      `framework '${name}' already exists for this customer`,
    );
  }

  const now = new Date();
  const [row] = await db
    .insert(frameworkAgreement)
    .values({
      customer_id: parsed.data.customer_id,
      name,
      start_date: parsed.data.start_date ?? null,
      end_date: parsed.data.end_date ?? null,
      notes: parsed.data.notes ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning({ framework_id: frameworkAgreement.framework_id });

  const detail = await getFrameworkDetail(row.framework_id);
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

  const existing = await db
    .select({ id: frameworkAgreement.framework_id })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (existing.length === 0) {
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
  updates.updated_at = new Date();

  try {
    await db
      .update(frameworkAgreement)
      .set(updates)
      .where(eq(frameworkAgreement.framework_id, framework_id));
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

  const [existing] = await db
    .select({ name: frameworkAgreement.name })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (!existing) {
    return err("not_found", `framework not found: ${framework_id}`);
  }

  const [{ n_rates, n_proj }] = await db
    .select({
      n_rates: sql<number>`(SELECT COUNT(*)::int FROM ${frameworkRate} WHERE ${frameworkRate.framework_id} = ${framework_id})`,
      n_proj: sql<number>`(SELECT COUNT(*)::int FROM ${project} WHERE ${project.framework_id} = ${framework_id})`,
    })
    .from(sql`(SELECT 1) AS dummy`);

  if ((n_rates > 0 || n_proj > 0) && !force) {
    return err(
      "has_children",
      `framework '${existing.name}' has ${n_rates} rate(s) and ${n_proj} project(s) linked. Pass force=true to cascade (rates removed, projects unlinked).`,
    );
  }

  if (force) {
    await db
      .delete(frameworkRate)
      .where(eq(frameworkRate.framework_id, framework_id));
    await db
      .update(project)
      .set({ framework_id: null, updated_at: new Date() })
      .where(eq(project.framework_id, framework_id));
  }

  await db
    .delete(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));

  return ok(null);
}

// ----------------------------------------------------------------------------
// Rates
// ----------------------------------------------------------------------------

async function defaultRateValidFrom(framework_id: number): Promise<string> {
  const [row] = await db
    .select({ start_date: frameworkAgreement.start_date })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (row && row.start_date) return row.start_date;
  return new Date().toISOString().slice(0, 10);
}

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

  const existsRow = await db
    .select({ id: frameworkAgreement.framework_id })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (existsRow.length === 0) {
    return err("not_found", `framework not found: ${framework_id}`);
  }

  const profile = parsed.data.profile.trim();
  if (!profile) return err("conflict", "rate profile cannot be empty");
  const valid_from = parsed.data.valid_from ?? (await defaultRateValidFrom(framework_id));

  const dup = await db
    .select({ existing: frameworkRate.daily_rate_eur })
    .from(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
  if (dup.length > 0) {
    return err(
      "conflict",
      `rate for profile '${profile}' on this framework effective ${valid_from} already exists (€${dup[0].existing}/day)`,
    );
  }

  // numeric column accepts string; pass the JS number stringified to preserve scale
  await db.insert(frameworkRate).values({
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

  const existing = await db
    .select({ existing: frameworkRate.daily_rate_eur })
    .from(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on framework ${framework_id} with valid_from ${valid_from}`,
    );
  }

  await db
    .update(frameworkRate)
    .set({ daily_rate_eur: String(parsed.data.daily_rate_eur) })
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
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
  const existing = await db
    .select({ existing: frameworkRate.daily_rate_eur })
    .from(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on framework ${framework_id} with valid_from ${valid_from}`,
    );
  }
  await db
    .delete(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
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
