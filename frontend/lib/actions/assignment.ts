"use server";

/** Phase C.5 — Assignment mutations + theoretical-margin estimate.
 *
 * Ports `src/dante/api/service/assignment.py` to TypeScript.
 * Five actions:
 *   - estimateAssignmentAction         (read-only what-if for the edit dialog)
 *   - createAssignmentAction
 *   - updateAssignmentAction
 *   - endAssignmentAction              (POST /assignments/{id}/end)
 *   - deleteAssignmentAction
 *
 * Key invariants ported verbatim:
 *   * exactly one of employee_id / freelancer_id (XOR)
 *   * allocation_pct ∈ (0, 1.5]
 *   * end_date ≥ start_date
 *   * freelancer assignments require an explicit profile (no role_tier fallback)
 *   * estimate uses FTE-aware revenue (40h baseline) and applies burden_factor
 *     to employee cost only (freelancers bill direct)
 */
import { z } from "zod";

import {
  deleteAssignment,
  getAssignmentDetail,
  getAssignmentProjectId,
  getAssignmentSource,
  getAssignmentStartDate,
  insertAssignment,
  setAssignmentEndDate,
  updateAssignment,
  type AssignmentDetail,
} from "@/lib/db/queries/assignment";
import { employeeExists } from "@/lib/db/queries/employee-annotation";
import { freelancerExists } from "@/lib/db/queries/freelancer";
import { projectExists } from "@/lib/db/queries/project";
import {
  getBurdenFactor,
  getEmployeeCompForCost,
  getEmployeeRoleTier,
  getEmployeeWeeklyHours,
  getEstimateProjectContext,
  getFreelancerForCost,
  resolveAssignmentRate,
} from "@/lib/db/queries/estimate";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";
import { audit } from "@/lib/auth/audit";
import { requireProjectAccess } from "@/lib/auth/project-capability";

const WORKING_DAYS_PER_MONTH = 20;
const WEEKS_PER_MONTH = 52 / 12;

/** Reject mutations against synthesized rows (source != 'manual').
 * The awork-planning rollup wipes and re-inserts on every sync, so any
 * hand-edit would be silently destroyed; surface a 422 instead. */
async function ensureManualAssignment(
  assignment_id: number,
): Promise<ActionResult<null>> {
  const source = await getAssignmentSource(assignment_id);
  if (source === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  if (source !== "manual") {
    return err(
      "validation_error",
      `assignment is auto-generated (source=${source}); edit the upstream awork booking instead`,
    );
  }
  return ok(null);
}

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const AllocationPct = z.number().gt(0).lte(1.5);

const CreateAssignmentSchema = z.object({
  employee_id: z.number().int().nullable().optional(),
  freelancer_id: z.number().int().nullable().optional(),
  project_id: z.number().int(),
  profile: z.string().nullable().optional(),
  allocation_pct: AllocationPct,
  start_date: IsoDate,
  end_date: IsoDate.nullable().optional(),
  daily_rate_override_eur: z.number().positive().nullable().optional(),
  daily_cost_override_eur: z.number().positive().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateAssignmentSchema = z.object({
  profile: z.string().nullable().optional(),
  allocation_pct: AllocationPct.optional(),
  start_date: IsoDate.optional(),
  end_date: IsoDate.nullable().optional(),
  daily_rate_override_eur: z.number().positive().nullable().optional(),
  daily_cost_override_eur: z.number().positive().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const EstimateRequestSchema = z.object({
  employee_id: z.number().int().nullable().optional(),
  freelancer_id: z.number().int().nullable().optional(),
  project_id: z.number().int(),
  allocation_pct: AllocationPct.default(1.0),
  profile: z.string().nullable().optional(),
  rate_override: z.number().positive().nullable().optional(),
  cost_override: z.number().positive().nullable().optional(),
  as_of: IsoDate.nullable().optional(),
});

// ----------------------------------------------------------------------------
// Helpers (pure math; DB reads live in lib/db/queries/estimate.ts)
// ----------------------------------------------------------------------------

type EmployeeCost = { base: number | null; basis: string };

async function employeeMonthlyCostPreBurden(
  employee_id: number,
): Promise<EmployeeCost> {
  const row = await getEmployeeCompForCost(employee_id);
  if (!row) return { base: null, basis: "unknown employee" };
  const fix = row.fix_salary === null ? null : Number(row.fix_salary);
  const interval = row.fix_salary_interval;
  const hourly = row.hourly_salary === null ? null : Number(row.hourly_salary);
  const weekly = row.weekly_working_hours;
  if (fix !== null && fix > 0 && interval === "yearly") {
    return { base: fix / 12, basis: "fix_salary yearly/12" };
  }
  if (fix !== null && fix > 0 && interval === "monthly") {
    return { base: fix, basis: "fix_salary monthly" };
  }
  if (hourly !== null && hourly > 0 && weekly !== null && weekly > 0) {
    return {
      base: hourly * weekly * WEEKS_PER_MONTH,
      basis: `hourly_salary €${hourly.toFixed(2)}/h × ${weekly}h/week × 52/12`,
    };
  }
  return { base: null, basis: "no salary or hourly comp on file" };
}

// ----------------------------------------------------------------------------
// estimateAssignmentAction
// ----------------------------------------------------------------------------

export type EstimateResponse = {
  kind: "employee" | "freelancer";
  entity_id: number;
  project_id: number;
  project_name: string;
  customer_name: string;
  billing_model: string;
  as_of: string;
  effective_profile: string | null;
  effective_daily_rate_eur: string | null;
  rate_source: string;
  monthly_cost_pre_alloc: string | null;
  monthly_cost_basis: string;
  burden_factor: string;
  monthly_revenue: string | null;
  monthly_gross_margin: string | null;
  monthly_gross_margin_pct: string | null;
  agreed_amount_eur: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
};

export async function estimateAssignmentAction(
  input: unknown,
): Promise<ActionResult<EstimateResponse>> {
  // Parse first so we can derive project_id for the capability check.
  const parsed = EstimateRequestSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const auth = await requireProjectAccess(parsed.data.project_id);
  if (!auth.ok) return auth.result;

  const {
    employee_id = null,
    freelancer_id = null,
    project_id,
    allocation_pct,
    profile,
    rate_override = null,
    cost_override = null,
    as_of = null,
  } = parsed.data;

  if ((employee_id === null) === (freelancer_id === null)) {
    return err(
      "validation_error",
      "exactly one of employee_id, freelancer_id must be provided",
    );
  }

  const projCtx = await getEstimateProjectContext(project_id);
  if (!projCtx) return err("not_found", `project not found: ${project_id}`);

  const billing_model = projCtx.billing_model;
  const framework_id = projCtx.framework_id;
  const agreed_amount = projCtx.agreed_amount_eur;
  const fp_start = projCtx.planned_start_date;
  const fp_end = projCtx.planned_end_date;
  const p_name = projCtx.project_name;
  const c_name = projCtx.customer_name;

  const burden = await getBurdenFactor();
  const as_of_date = as_of ?? new Date().toISOString().slice(0, 10);

  let effective_profile = profile ?? null;
  if (employee_id !== null && !effective_profile) {
    effective_profile = await getEmployeeRoleTier(employee_id);
  }

  let monthly_cost: number | null = null;
  let basis: string;
  let kind: "employee" | "freelancer";
  let who_id: number;
  if (employee_id !== null) {
    const ec = await employeeMonthlyCostPreBurden(employee_id);
    basis = ec.basis;
    if (cost_override !== null) {
      monthly_cost = cost_override * WORKING_DAYS_PER_MONTH;
      basis = `override €${cost_override}/day × ${WORKING_DAYS_PER_MONTH}`;
    } else if (ec.base !== null) {
      monthly_cost = ec.base * burden;
      basis = `${ec.basis} × burden ×${burden}`;
    }
    kind = "employee";
    who_id = employee_id;
  } else {
    const flRow = await getFreelancerForCost(freelancer_id!);
    if (!flRow) {
      return err("not_found", `freelancer not found: ${freelancer_id}`);
    }
    const daily_cost = cost_override ?? Number(flRow.daily_cost_eur);
    monthly_cost = daily_cost * WORKING_DAYS_PER_MONTH;
    basis = `daily €${daily_cost.toFixed(2)} × ${WORKING_DAYS_PER_MONTH} (no burden)`;
    kind = "freelancer";
    who_id = freelancer_id!;
  }

  let effective_rate: number | null;
  let rate_source: string;
  if (rate_override !== null) {
    effective_rate = rate_override;
    rate_source = "rate_override";
  } else {
    const r = await resolveAssignmentRate({
      project_id,
      framework_id,
      profile: effective_profile,
      as_of: as_of_date,
    });
    effective_rate = r.rate;
    rate_source = r.source;
  }

  let fte_factor = 1.0;
  if (employee_id !== null) {
    const hours = await getEmployeeWeeklyHours(employee_id);
    if (hours !== null && hours > 0) fte_factor = hours / 40.0;
  }

  let monthly_revenue: number | null = null;
  let monthly_margin: number | null = null;
  let margin_pct: number | null = null;
  if (billing_model === "time_and_material" && effective_rate !== null) {
    // `allocation_pct` is a fraction of full-time, so revenue = rate ×
    // days × alloc (a fully-booked 88% consultant → alloc 0.875 bills 7h
    // of an 8h day). Cost, by contrast, is the person's FULL salary at
    // full commitment, so it divides by fte (alloc/fte = share of their
    // own capacity). No × fte on revenue — that double-discounts.
    monthly_revenue =
      effective_rate * WORKING_DAYS_PER_MONTH * allocation_pct;
    if (monthly_cost !== null) {
      const allocated_cost = (monthly_cost * allocation_pct) / fte_factor;
      monthly_margin = monthly_revenue - allocated_cost;
      if (monthly_revenue > 0) {
        margin_pct = (monthly_margin / monthly_revenue) * 100;
      }
    }
  }

  return ok({
    kind,
    entity_id: who_id,
    project_id,
    project_name: p_name,
    customer_name: c_name,
    billing_model,
    as_of: as_of_date,
    effective_profile,
    effective_daily_rate_eur:
      effective_rate === null ? null : effective_rate.toFixed(2),
    rate_source,
    monthly_cost_pre_alloc:
      monthly_cost === null ? null : monthly_cost.toFixed(2),
    monthly_cost_basis: basis,
    burden_factor: String(burden),
    monthly_revenue:
      monthly_revenue === null ? null : monthly_revenue.toFixed(2),
    monthly_gross_margin:
      monthly_margin === null ? null : monthly_margin.toFixed(2),
    monthly_gross_margin_pct:
      margin_pct === null ? null : margin_pct.toFixed(2),
    agreed_amount_eur: agreed_amount === null ? null : String(agreed_amount),
    planned_start_date: fp_start,
    planned_end_date: fp_end,
  });
}

// ----------------------------------------------------------------------------
// createAssignmentAction
// ----------------------------------------------------------------------------

export async function createAssignmentAction(
  input: unknown,
): Promise<ActionResult<AssignmentDetail>> {
  const parsed = CreateAssignmentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const auth = await requireProjectAccess(parsed.data.project_id);
  if (!auth.ok) return auth.result;

  const {
    employee_id = null,
    freelancer_id = null,
    project_id,
    profile = null,
    allocation_pct,
    start_date,
    end_date = null,
    daily_rate_override_eur = null,
    daily_cost_override_eur = null,
    notes = null,
  } = parsed.data;

  if ((employee_id === null) === (freelancer_id === null)) {
    await audit(auth.ctx, {
      action: "assignment_created_denied",
      target_type: "assignment",
      target_id: project_id,
    });
    return err(
      "validation_error",
      "exactly one of employee_id, freelancer_id must be provided",
    );
  }
  if (end_date !== null && end_date < start_date) {
    await audit(auth.ctx, {
      action: "assignment_created_denied",
      target_type: "assignment",
      target_id: project_id,
    });
    return err("validation_error", "end_date must be on or after start_date");
  }

  if (!(await projectExists(project_id))) {
    await audit(auth.ctx, {
      action: "assignment_created_denied",
      target_type: "assignment",
      target_id: project_id,
    });
    return err("not_found", `project not found: ${project_id}`);
  }
  if (employee_id !== null) {
    if (!(await employeeExists(employee_id))) {
      await audit(auth.ctx, {
        action: "assignment_created_denied",
        target_type: "assignment",
        target_id: project_id,
      });
      return err("not_found", `employee not found: ${employee_id}`);
    }
  }
  if (freelancer_id !== null) {
    if (!(await freelancerExists(freelancer_id))) {
      await audit(auth.ctx, {
        action: "assignment_created_denied",
        target_type: "assignment",
        target_id: project_id,
      });
      return err("not_found", `freelancer not found: ${freelancer_id}`);
    }
  }
  if (freelancer_id !== null && !profile) {
    await audit(auth.ctx, {
      action: "assignment_created_denied",
      target_type: "assignment",
      target_id: project_id,
    });
    return err(
      "validation_error",
      "freelancer assignments require profile (no role_tier fallback)",
    );
  }

  const inserted = await insertAssignment({
    employee_id,
    freelancer_id,
    project_id,
    profile,
    allocation_pct: String(allocation_pct),
    start_date,
    end_date,
    daily_rate_override_eur:
      daily_rate_override_eur === null ? null : String(daily_rate_override_eur),
    daily_cost_override_eur:
      daily_cost_override_eur === null ? null : String(daily_cost_override_eur),
    notes,
  });

  const detail = await getAssignmentDetail(inserted.assignment_id);
  if (!detail) return err("internal_error", "created assignment not found");

  await audit(auth.ctx, {
    action: "assignment_created",
    target_type: "assignment",
    target_id: inserted.assignment_id,
  });
  return ok(detail);
}

// ----------------------------------------------------------------------------
// updateAssignmentAction
// ----------------------------------------------------------------------------

export async function updateAssignmentAction(
  assignment_id: number,
  input: unknown,
): Promise<ActionResult<AssignmentDetail>> {
  if (!Number.isInteger(assignment_id)) {
    return err("validation_error", `invalid assignment id: ${assignment_id}`);
  }
  const project_id = await getAssignmentProjectId(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const parsed = UpdateAssignmentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) {
    await audit(auth.ctx, {
      action: "assignment_updated_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return guard;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.profile !== undefined) updates.profile = parsed.data.profile;
  if (parsed.data.allocation_pct !== undefined) {
    updates.allocation_pct = String(parsed.data.allocation_pct);
  }
  if (parsed.data.start_date !== undefined) {
    updates.start_date = parsed.data.start_date;
  }
  if (parsed.data.end_date !== undefined) {
    updates.end_date = parsed.data.end_date;
  }
  if (parsed.data.daily_rate_override_eur !== undefined) {
    updates.daily_rate_override_eur =
      parsed.data.daily_rate_override_eur === null
        ? null
        : String(parsed.data.daily_rate_override_eur);
  }
  if (parsed.data.daily_cost_override_eur !== undefined) {
    updates.daily_cost_override_eur =
      parsed.data.daily_cost_override_eur === null
        ? null
        : String(parsed.data.daily_cost_override_eur);
  }
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  if (Object.keys(updates).length === 0) {
    const d = await getAssignmentDetail(assignment_id);
    if (!d) {
      await audit(auth.ctx, {
        action: "assignment_updated_denied",
        target_type: "assignment",
        target_id: assignment_id,
      });
      return err("not_found", `assignment not found: ${assignment_id}`);
    }
    return ok(d);
  }
  updates.updated_at = new Date();
  await updateAssignment(assignment_id, updates);

  const d = await getAssignmentDetail(assignment_id);
  if (!d) {
    await audit(auth.ctx, {
      action: "assignment_updated_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  await audit(auth.ctx, {
    action: "assignment_updated",
    target_type: "assignment",
    target_id: assignment_id,
  });
  return ok(d);
}

// ----------------------------------------------------------------------------
// endAssignmentAction
// ----------------------------------------------------------------------------

const EndAssignmentSchema = z.object({
  end_date: IsoDate,
});

export async function endAssignmentAction(
  assignment_id: number,
  input: unknown,
): Promise<ActionResult<AssignmentDetail>> {
  if (!Number.isInteger(assignment_id)) {
    return err("validation_error", `invalid assignment id: ${assignment_id}`);
  }
  const project_id = await getAssignmentProjectId(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const parsed = EndAssignmentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) {
    await audit(auth.ctx, {
      action: "assignment_ended_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return guard;
  }

  const existing = await getAssignmentStartDate(assignment_id);
  if (!existing) {
    await audit(auth.ctx, {
      action: "assignment_ended_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  if (parsed.data.end_date < existing.start_date!) {
    await audit(auth.ctx, {
      action: "assignment_ended_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return err("validation_error", "end_date must be on or after start_date");
  }

  await setAssignmentEndDate(assignment_id, parsed.data.end_date);

  const d = await getAssignmentDetail(assignment_id);
  if (!d) {
    await audit(auth.ctx, {
      action: "assignment_ended_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  await audit(auth.ctx, {
    action: "assignment_ended",
    target_type: "assignment",
    target_id: assignment_id,
  });
  return ok(d);
}

// ----------------------------------------------------------------------------
// deleteAssignmentAction
// ----------------------------------------------------------------------------

export async function deleteAssignmentAction(
  assignment_id: number,
): Promise<ActionResult<null>> {
  if (!Number.isInteger(assignment_id)) {
    return err("validation_error", `invalid assignment id: ${assignment_id}`);
  }
  const project_id = await getAssignmentProjectId(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) {
    await audit(auth.ctx, {
      action: "assignment_deleted_denied",
      target_type: "assignment",
      target_id: assignment_id,
    });
    return guard;
  }
  await deleteAssignment(assignment_id);
  await audit(auth.ctx, {
    action: "assignment_deleted",
    target_type: "assignment",
    target_id: assignment_id,
  });
  return ok(null);
}
