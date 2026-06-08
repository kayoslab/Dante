"use server";

/** Phase C.3 — Freelancer mutations as Server Actions.
 *
 * Ports `src/dante/api/service/freelancer.py` to TypeScript.
 * Three actions: create / update / delete. The delete cascades through
 * `assignment` when `force=true`.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  getFreelancerDetail,
  type FreelancerDetail,
} from "@/lib/db/queries/freelancer";
import { assignment, freelancer } from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

const CreateFreelancerSchema = z.object({
  name: z.string().min(1).max(200),
  daily_cost_eur: z.number().positive(),
  status: z.string().min(1).default("active"),
  contact_email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateFreelancerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  daily_cost_eur: z.number().positive().optional(),
  status: z.string().min(1).optional(),
  contact_email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function createFreelancerAction(
  input: unknown,
): Promise<ActionResult<FreelancerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateFreelancerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const name = parsed.data.name.trim();
  if (!name) return err("conflict", "freelancer name cannot be empty");

  const dup = await db
    .select({ id: freelancer.freelancer_id })
    .from(freelancer)
    .where(eq(freelancer.name, name));
  if (dup.length > 0) {
    return err("conflict", `freelancer already exists: ${name}`);
  }

  const now = new Date();
  let inserted;
  try {
    inserted = await db
      .insert(freelancer)
      .values({
        name,
        daily_cost_eur: String(parsed.data.daily_cost_eur),
        status: parsed.data.status,
        contact_email: parsed.data.contact_email ?? null,
        notes: parsed.data.notes ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning({ freelancer_id: freelancer.freelancer_id });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", `could not create freelancer (unique violation)`);
    }
    throw e;
  }

  const detail = await getFreelancerDetail(inserted[0].freelancer_id);
  if (!detail) return err("internal_error", "created freelancer not found");
  return ok(detail);
}

export async function updateFreelancerAction(
  freelancer_id: number,
  input: unknown,
): Promise<ActionResult<FreelancerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(freelancer_id)) {
    return err("validation_error", `invalid freelancer id: ${freelancer_id}`);
  }
  const parsed = UpdateFreelancerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const existing = await db
    .select({ id: freelancer.freelancer_id })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  if (existing.length === 0) {
    return err("not_found", `freelancer not found: ${freelancer_id}`);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
  if (parsed.data.daily_cost_eur !== undefined) {
    updates.daily_cost_eur = String(parsed.data.daily_cost_eur);
  }
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.contact_email !== undefined) {
    updates.contact_email = parsed.data.contact_email;
  }
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  if (Object.keys(updates).length === 0) {
    const d = await getFreelancerDetail(freelancer_id);
    if (!d) return err("not_found", `freelancer not found: ${freelancer_id}`);
    return ok(d);
  }
  updates.updated_at = new Date();

  try {
    await db
      .update(freelancer)
      .set(updates)
      .where(eq(freelancer.freelancer_id, freelancer_id));
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", "freelancer name already exists");
    }
    throw e;
  }

  const detail = await getFreelancerDetail(freelancer_id);
  if (!detail) return err("not_found", `freelancer not found: ${freelancer_id}`);
  return ok(detail);
}

export async function deleteFreelancerAction(
  freelancer_id: number,
  force = false,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(freelancer_id)) {
    return err("validation_error", `invalid freelancer id: ${freelancer_id}`);
  }

  const [existing] = await db
    .select({ name: freelancer.name })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  if (!existing) {
    return err("not_found", `freelancer not found: ${freelancer_id}`);
  }

  const asn = await db
    .select({ id: assignment.assignment_id })
    .from(assignment)
    .where(eq(assignment.freelancer_id, freelancer_id));

  if (asn.length > 0 && !force) {
    return err(
      "has_children",
      `freelancer '${existing.name}' has ${asn.length} assignment(s). Pass force=true to cascade.`,
    );
  }

  if (force && asn.length > 0) {
    await db.delete(assignment).where(eq(assignment.freelancer_id, freelancer_id));
  }
  await db.delete(freelancer).where(eq(freelancer.freelancer_id, freelancer_id));
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
