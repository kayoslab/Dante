"use server";

/** Server actions for the freelancer monthly hours grid.
 *
 * `setFreelancerHoursAction(input)` — set/update one cell. Looks up the
 * assignment to (a) derive project_id for the capability check and
 * (b) enforce that the assignment is for a freelancer (CHECK can't
 * cross tables). source='manual' on every write here; the awork sync
 * is the only writer of source='awork' rows.
 *
 * `deleteFreelancerHoursAction` — clear a cell. Manual deletion only.
 *
 * Authorization: `requireProjectAccess` — admins/managers always pass,
 * SDMs pass if they have a grant on the project's id. */
import { z } from "zod";

import { audit } from "@/lib/auth/audit";
import {
  deleteFreelancerHours,
  getFreelancerAssignmentMeta,
  upsertFreelancerHours,
} from "@/lib/db/queries/freelancer-hours";
import { requireProjectAccess } from "@/lib/auth/project-capability";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";

const SetHoursSchema = z.object({
  assignment_id: z.number().int().positive(),
  year_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "year_month must be YYYY-MM"),
  hours_decimal: z
    .number()
    .min(0, "hours must be >= 0")
    .max(744, "hours must be <= 744 (≈31 days × 24h)"),
});

const DeleteHoursSchema = z.object({
  assignment_id: z.number().int().positive(),
  year_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "year_month must be YYYY-MM"),
});

export async function setFreelancerHoursAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const parsed = SetHoursSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { assignment_id, year_month, hours_decimal } = parsed.data;

  const meta = await getFreelancerAssignmentMeta(assignment_id);
  if (!meta) return err("not_found", `assignment not found: ${assignment_id}`);
  if (meta.freelancer_id === null) {
    return err(
      "validation_error",
      "Hours can only be logged on freelancer assignments.",
    );
  }
  const auth = await requireProjectAccess(meta.project_id);
  if (!auth.ok) return auth.result;

  // Manual writes always override (including overriding awork-sourced rows).
  await upsertFreelancerHours({
    assignment_id,
    year_month,
    hours_decimal,
    entered_by: auth.ctx.user_id,
  });

  await audit(auth.ctx, {
    action: "freelancer_hours_set",
    target_type: "assignment",
    target_id: `${assignment_id}/${year_month}`,
  });

  return ok(null);
}

export async function deleteFreelancerHoursAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const parsed = DeleteHoursSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { assignment_id, year_month } = parsed.data;

  const meta = await getFreelancerAssignmentMeta(assignment_id);
  if (!meta) return err("not_found", `assignment not found: ${assignment_id}`);
  if (meta.freelancer_id === null) {
    return err(
      "validation_error",
      "Hours can only be logged on freelancer assignments.",
    );
  }
  const auth = await requireProjectAccess(meta.project_id);
  if (!auth.ok) return auth.result;

  await deleteFreelancerHours({ assignment_id, year_month });

  await audit(auth.ctx, {
    action: "freelancer_hours_cleared",
    target_type: "assignment",
    target_id: `${assignment_id}/${year_month}`,
  });

  return ok(null);
}
