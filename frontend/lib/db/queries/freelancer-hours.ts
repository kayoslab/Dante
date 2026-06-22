/** Freelancer monthly time-entry queries.
 *
 * The "hours" side of the freelancer cost calculation. The project page
 * fetches all rows for the project in one go so the grid renders without
 * an N+1 per cell.
 *
 * `source`:
 *   - 'manual' — SDM (or admin/manager) typed it in. Always wins over awork.
 *   - 'awork'  — the awork sync wrote it from time entries. UI shows a
 *                small pill so the SDM knows what's auto-filled.
 *
 * Hours storage is `hours_decimal` (NUMERIC(8,2)) — display can convert
 * to days at 8h/day when needed. */
import { and, eq } from "drizzle-orm";

import { db } from "../client";
import { assignment, freelancerTimeEntry } from "../schema";

export type FreelancerHoursEntry = {
  assignment_id: number;
  year_month: string;
  hours_decimal: string;
  source: "manual" | "awork";
};

export type FreelancerAssignmentMeta = {
  project_id: number;
  freelancer_id: number | null;
};

/** Look up the project + freelancer linkage for an assignment. Caller
 * uses the project_id for the capability gate and the freelancer_id to
 * reject set/delete on employee assignments (a CHECK can't enforce this
 * across tables). Returns null when the assignment doesn't exist. */
export async function getFreelancerAssignmentMeta(
  assignment_id: number,
): Promise<FreelancerAssignmentMeta | null> {
  const [row] = await db
    .select({
      project_id: assignment.project_id,
      freelancer_id: assignment.freelancer_id,
    })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id))
    .limit(1);
  return row ?? null;
}

/** Upsert a freelancer hours cell. `source='manual'` always overrides
 * whatever the awork sync wrote — manual entry wins. */
export async function upsertFreelancerHours(opts: {
  assignment_id: number;
  year_month: string;
  hours_decimal: number;
  entered_by: string;
}): Promise<void> {
  await db
    .insert(freelancerTimeEntry)
    .values({
      assignment_id: opts.assignment_id,
      year_month: opts.year_month,
      hours_decimal: String(opts.hours_decimal),
      source: "manual",
      entered_by: opts.entered_by,
    })
    .onConflictDoUpdate({
      target: [freelancerTimeEntry.assignment_id, freelancerTimeEntry.year_month],
      set: {
        hours_decimal: String(opts.hours_decimal),
        source: "manual",
        entered_by: opts.entered_by,
        entered_at: new Date(),
      },
    });
}

/** Clear a freelancer hours cell. */
export async function deleteFreelancerHours(opts: {
  assignment_id: number;
  year_month: string;
}): Promise<void> {
  await db
    .delete(freelancerTimeEntry)
    .where(
      and(
        eq(freelancerTimeEntry.assignment_id, opts.assignment_id),
        eq(freelancerTimeEntry.year_month, opts.year_month),
      ),
    );
}

/** All freelancer hours rows for a project, joined through assignment. */
export async function getFreelancerHoursForProject(
  project_id: number,
): Promise<FreelancerHoursEntry[]> {
  const rows = await db
    .select({
      assignment_id: freelancerTimeEntry.assignment_id,
      year_month: freelancerTimeEntry.year_month,
      hours_decimal: freelancerTimeEntry.hours_decimal,
      source: freelancerTimeEntry.source,
    })
    .from(freelancerTimeEntry)
    .innerJoin(
      assignment,
      eq(assignment.assignment_id, freelancerTimeEntry.assignment_id),
    )
    .where(eq(assignment.project_id, project_id));
  return rows.map((r) => ({
    assignment_id: r.assignment_id,
    year_month: r.year_month,
    hours_decimal: String(r.hours_decimal),
    source: r.source,
  }));
}
