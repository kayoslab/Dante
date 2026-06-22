/** Mutation helpers backing `lib/actions/employee.ts`.
 *
 * `employee_annotation` is the analytics-only sidecar to the
 * Personio-sourced `employee_current` table — we never write the
 * Personio-managed columns from the app. Keeping the writes here (not
 * in `employee.ts` which is read-heavy) makes the split between
 * Personio-sourced reads and app-managed annotation writes explicit
 * at import-site.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import {
  employeeAnnotation,
  employeeCurrent,
  team,
} from "../schema";

export async function employeeExists(employee_id: number): Promise<boolean> {
  const r = await db
    .select({ id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  return r.length > 0;
}

export async function teamExists(name: string): Promise<boolean> {
  const r = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, name));
  return r.length > 0;
}

/** Upsert the annotation row, then apply the supplied analytics-only
 * field updates. Mirrors the prior inline sequence in
 * `lib/actions/employee.ts`: the upsert always runs (so the row exists
 * for an employee who has never been annotated); the UPDATE only fires
 * when there's something to set, and stamps `last_reconciled_at` on the
 * same statement. */
export async function applyEmployeeAnnotationUpdates(
  employee_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db.execute(sql`
    INSERT INTO employee_annotation (employee_id, last_reconciled_at)
    VALUES (${employee_id}, ${now})
    ON CONFLICT (employee_id) DO NOTHING
  `);

  if (Object.keys(updates).length === 0) return;
  const next = { ...updates, last_reconciled_at: now };
  await db
    .update(employeeAnnotation)
    .set(next)
    .where(eq(employeeAnnotation.employee_id, employee_id));
}
