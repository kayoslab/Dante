"use server";

/** Phase C.3 — Freelancer mutations as Server Actions.
 *
 * Ports `src/dante/api/service/freelancer.py` to TypeScript.
 * Three actions: create / update / delete. The delete cascades through
 * `assignment` when `force=true`.
 */
import { z } from "zod";

import {
  countFreelancerAssignments,
  deleteFreelancerCascading,
  findFreelancerIdByName,
  freelancerExists,
  getFreelancerDetail,
  getFreelancerName,
  insertFreelancer,
  updateFreelancerById,
  type FreelancerDetail,
} from "@/lib/db/queries/freelancer";

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

  if ((await findFreelancerIdByName(name)) !== null) {
    return err("conflict", `freelancer already exists: ${name}`);
  }

  const now = new Date();
  let freelancer_id: number;
  try {
    freelancer_id = await insertFreelancer({
      name,
      daily_cost_eur: String(parsed.data.daily_cost_eur),
      status: parsed.data.status,
      contact_email: parsed.data.contact_email ?? null,
      notes: parsed.data.notes ?? null,
      created_at: now,
      updated_at: now,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", `could not create freelancer (unique violation)`);
    }
    throw e;
  }

  const detail = await getFreelancerDetail(freelancer_id);
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

  if (!(await freelancerExists(freelancer_id))) {
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
    await updateFreelancerById(freelancer_id, updates);
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

  const name = await getFreelancerName(freelancer_id);
  if (name === null) {
    return err("not_found", `freelancer not found: ${freelancer_id}`);
  }

  const n_assignments = await countFreelancerAssignments(freelancer_id);

  if (n_assignments > 0 && !force) {
    return err(
      "has_children",
      `freelancer '${name}' has ${n_assignments} assignment(s). Pass force=true to cascade.`,
    );
  }

  await deleteFreelancerCascading(freelancer_id, {
    cascadeAssignments: force && n_assignments > 0,
  });
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
