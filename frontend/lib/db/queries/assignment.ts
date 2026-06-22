import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import { assignment } from "../schema";

export type AssignmentDetail = {
  assignment_id: number;
  kind: "employee" | "freelancer";
  who_name: string | null;
  employee_id: number | null;
  freelancer_id: number | null;
  project_id: number;
  project_name: string;
  customer_name: string;
  profile: string | null;
  allocation_pct: string;
  start_date: string | null;
  end_date: string | null;
  daily_rate_override_eur: string | null;
  daily_cost_override_eur: string | null;
  effective_profile: string | null;
  effective_daily_rate_eur: string | null;
  rate_source: string | null;
  notes: string | null;
  created_at: string;
};

export async function getAssignmentDetail(
  assignment_id: number,
): Promise<AssignmentDetail | null> {
  const r = await db.execute(sql`
    SELECT a.assignment_id,
           CASE WHEN a.employee_id IS NOT NULL THEN 'employee' ELSE 'freelancer' END AS kind,
           COALESCE(ec.first_name || ' ' || ec.last_name, f.name) AS who_name,
           a.employee_id, a.freelancer_id, a.project_id,
           p.name AS project_name, c.name AS customer_name,
           a.profile, a.allocation_pct,
           a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur,
           aer.effective_profile, aer.effective_daily_rate_eur, aer.rate_source,
           a.notes, a.created_at
    FROM assignment a
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    LEFT JOIN freelancer f ON f.freelancer_id = a.freelancer_id
    LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
    WHERE a.assignment_id = ${assignment_id}
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    assignment_id: row.assignment_id as number,
    kind: row.kind as "employee" | "freelancer",
    who_name: (row.who_name as string | null) ?? null,
    employee_id: (row.employee_id as number | null) ?? null,
    freelancer_id: (row.freelancer_id as number | null) ?? null,
    project_id: row.project_id as number,
    project_name: row.project_name as string,
    customer_name: row.customer_name as string,
    profile: (row.profile as string | null) ?? null,
    allocation_pct: String(row.allocation_pct),
    start_date: (row.start_date as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? null,
    daily_rate_override_eur:
      row.daily_rate_override_eur === null ||
      row.daily_rate_override_eur === undefined
        ? null
        : String(row.daily_rate_override_eur),
    daily_cost_override_eur:
      row.daily_cost_override_eur === null ||
      row.daily_cost_override_eur === undefined
        ? null
        : String(row.daily_cost_override_eur),
    effective_profile: (row.effective_profile as string | null) ?? null,
    effective_daily_rate_eur:
      row.effective_daily_rate_eur === null ||
      row.effective_daily_rate_eur === undefined
        ? null
        : String(row.effective_daily_rate_eur),
    rate_source: (row.rate_source as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_at: new Date(row.created_at as Date | string).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* mutation helpers — used by lib/actions/assignment.ts                */
/* ------------------------------------------------------------------ */

/** Resolve the project_id behind an assignment so the caller can run a
 * project capability check. Returns NULL when no such assignment
 * exists — caller surfaces that as `not_found`. */
export async function getAssignmentProjectId(
  assignment_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ project_id: assignment.project_id })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id))
    .limit(1);
  return row?.project_id ?? null;
}

/** Read the `source` column to gate mutations against synthesized
 * rows. The awork-planning rollup wipes and re-inserts on every sync,
 * so any hand-edit of an auto-generated row would be silently
 * destroyed; the action surfaces a 422 instead. Returns NULL when no
 * such assignment exists. */
export async function getAssignmentSource(
  assignment_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ source: assignment.source })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id))
    .limit(1);
  return row?.source ?? null;
}

export type InsertAssignmentInput = {
  employee_id: number | null;
  freelancer_id: number | null;
  project_id: number;
  profile: string | null;
  allocation_pct: string;
  start_date: string;
  end_date: string | null;
  daily_rate_override_eur: string | null;
  daily_cost_override_eur: string | null;
  notes: string | null;
};

/** Insert a brand-new manual assignment row. The caller has already
 * normalised numeric fields to strings (the wire convention — see
 * AGENTS.md § Money & decimals). */
export async function insertAssignment(
  input: InsertAssignmentInput,
): Promise<{ assignment_id: number }> {
  const now = new Date();
  const [row] = await db
    .insert(assignment)
    .values({
      employee_id: input.employee_id,
      freelancer_id: input.freelancer_id,
      project_id: input.project_id,
      profile: input.profile,
      allocation_pct: input.allocation_pct,
      start_date: input.start_date,
      end_date: input.end_date,
      daily_rate_override_eur: input.daily_rate_override_eur,
      daily_cost_override_eur: input.daily_cost_override_eur,
      notes: input.notes,
      created_at: now,
      updated_at: now,
    })
    .returning({ assignment_id: assignment.assignment_id });
  return row;
}

/** Apply a partial update to an existing assignment row. The caller
 * normalises numeric fields to strings and supplies the `updated_at`
 * timestamp. The `updates` map is passed through as Drizzle's loose
 * `Record<string, unknown>` so the caller can include only the
 * provided fields — empty maps are filtered upstream. */
export async function updateAssignment(
  assignment_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(assignment)
    .set(updates)
    .where(eq(assignment.assignment_id, assignment_id));
}

/** Read just the `start_date` for the end-date validation guard. */
export async function getAssignmentStartDate(
  assignment_id: number,
): Promise<{ start_date: string | null } | null> {
  const [row] = await db
    .select({ start_date: assignment.start_date })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id));
  return row ?? null;
}

/** End an assignment by writing `end_date` + bumping `updated_at`. */
export async function setAssignmentEndDate(
  assignment_id: number,
  end_date: string,
): Promise<void> {
  await db
    .update(assignment)
    .set({ end_date, updated_at: new Date() })
    .where(eq(assignment.assignment_id, assignment_id));
}

/** Hard-delete an assignment row. Caller has already enforced the
 * "manual source only" guard. */
export async function deleteAssignment(assignment_id: number): Promise<void> {
  await db
    .delete(assignment)
    .where(eq(assignment.assignment_id, assignment_id));
}
