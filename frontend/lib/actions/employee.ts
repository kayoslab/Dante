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
import { z } from "zod";

import {
  getEmployeeDetail,
  type EmployeeDetail,
} from "@/lib/db/queries/employee";
import {
  applyEmployeeAnnotationUpdates,
  employeeExists,
  teamExists,
} from "@/lib/db/queries/employee-annotation";
import { audit } from "@/lib/auth/audit";

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
  const ctx = auth.ctx;

  if (!Number.isInteger(employee_id)) {
    return err("validation_error", `invalid employee id: ${employee_id}`);
  }
  const parsed = FlagsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await employeeExists(employee_id))) {
    await audit(ctx, {
      action: "employee_annotation_updated_denied",
      target_type: "employee_annotation",
      target_id: employee_id,
    });
    return err("not_found", `employee not found: ${employee_id}`);
  }

  // Validate team_user when caller is setting (not clearing) it.
  if (
    parsed.data.team_user !== undefined &&
    parsed.data.team_user !== null &&
    !parsed.data.clear_team
  ) {
    const teamName = parsed.data.team_user.trim();
    if (!(await teamExists(teamName))) {
      return err(
        "validation_error",
        `unknown team '${teamName}' — create it under Settings first`,
      );
    }
  }

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

  await applyEmployeeAnnotationUpdates(employee_id, updates);

  const detail = await getEmployeeDetail(employee_id);
  if (!detail) {
    await audit(ctx, {
      action: "employee_annotation_updated_denied",
      target_type: "employee_annotation",
      target_id: employee_id,
    });
    return err("not_found", `employee not found: ${employee_id}`);
  }

  await audit(ctx, {
    action: "employee_annotation_updated",
    target_type: "employee_annotation",
    target_id: employee_id,
  });

  return ok(detail);
}
