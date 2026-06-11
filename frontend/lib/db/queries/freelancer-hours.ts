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
import { eq } from "drizzle-orm";

import { db } from "../client";
import { assignment, freelancerTimeEntry } from "../schema";

export type FreelancerHoursEntry = {
  assignment_id: number;
  year_month: string;
  hours_decimal: string;
  source: "manual" | "awork";
};

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
