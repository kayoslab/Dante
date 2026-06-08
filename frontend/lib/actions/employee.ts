"use server";

/** Phase C.7 — Employee flags update as a Server Action.
 *
 * Ports `update_employee_flags` from `src/dante/api/service/employee.py`.
 * One action: PATCH /employees/{id}/flags. Modifies the analytics-only
 * fields on `employee_annotation` (never Personio-sourced columns):
 *
 *   - is_real_employee
 *   - is_project_contributing
 *   - is_multi_org
 *   - team_user (only when the named team exists; `clear_team=true` to unassign)
 *
 * The annotation row is upserted first so this works for employees who've
 * never been annotated. team_user is validated against the canonical
 * `team` table — unknown values get rejected so the FE can't drift the
 * curated team list silently.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  getEmployeeDetail,
  type EmployeeDetail,
} from "@/lib/db/queries/employee";
import {
  employeeAnnotation,
  employeeCurrent,
  team,
} from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";

const FlagsSchema = z.object({
  is_real_employee: z.boolean().nullable().optional(),
  is_project_contributing: z.boolean().nullable().optional(),
  is_multi_org: z.boolean().nullable().optional(),
  team_user: z.string().nullable().optional(),
  clear_team: z.boolean().nullable().optional(),
});

export async function updateEmployeeFlagsAction(
  employee_id: number,
  input: unknown,
): Promise<ActionResult<EmployeeDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(employee_id)) {
    return err("validation_error", `invalid employee id: ${employee_id}`);
  }
  const parsed = FlagsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const exists = await db
    .select({ id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  if (exists.length === 0) {
    return err("not_found", `employee not found: ${employee_id}`);
  }

  // Validate team_user when caller is setting (not clearing) it.
  if (
    parsed.data.team_user !== undefined &&
    parsed.data.team_user !== null &&
    !parsed.data.clear_team
  ) {
    const teamName = parsed.data.team_user.trim();
    const t = await db
      .select({ name: team.team_name })
      .from(team)
      .where(eq(team.team_name, teamName));
    if (t.length === 0) {
      return err(
        "validation_error",
        `unknown team '${teamName}' — create it under Settings first`,
      );
    }
  }

  const now = new Date();
  // Ensure the annotation row exists.
  await db.execute(sql`
    INSERT INTO employee_annotation (employee_id, last_reconciled_at)
    VALUES (${employee_id}, ${now})
    ON CONFLICT (employee_id) DO NOTHING
  `);

  const updates: Record<string, unknown> = {};
  if (parsed.data.is_real_employee !== undefined && parsed.data.is_real_employee !== null) {
    updates.is_real_employee = parsed.data.is_real_employee;
  }
  if (parsed.data.is_project_contributing !== undefined && parsed.data.is_project_contributing !== null) {
    updates.is_project_contributing = parsed.data.is_project_contributing;
  }
  if (parsed.data.is_multi_org !== undefined && parsed.data.is_multi_org !== null) {
    updates.is_multi_org = parsed.data.is_multi_org;
  }
  if (parsed.data.clear_team) {
    updates.team_user = null;
  } else if (parsed.data.team_user !== undefined && parsed.data.team_user !== null) {
    updates.team_user = parsed.data.team_user.trim();
  }

  if (Object.keys(updates).length > 0) {
    updates.last_reconciled_at = now;
    await db
      .update(employeeAnnotation)
      .set(updates)
      .where(eq(employeeAnnotation.employee_id, employee_id));
  }

  const detail = await getEmployeeDetail(employee_id);
  if (!detail) return err("not_found", `employee not found: ${employee_id}`);
  return ok(detail);
}
