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
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  getAssignmentDetail,
  type AssignmentDetail,
} from "@/lib/db/queries/assignment";
import {
  assignment,
  customer,
  employeeCurrent,
  freelancer,
  project,
  setting,
} from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";
import { requireProjectAccess } from "@/lib/auth/project-capability";

const WORKING_DAYS_PER_MONTH = 20;
const WEEKS_PER_MONTH = 52 / 12;

/** Resolve the project_id behind an assignment so we can run the project
 * capability check. Returns null when no such assignment exists — caller
 * surfaces that as a not_found ActionResult. */
async function projectIdOfAssignment(
  assignment_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ project_id: assignment.project_id })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id))
    .limit(1);
  return row?.project_id ?? null;
}

/** Reject mutations against synthesized rows (source != 'manual').
 * The awork-planning rollup wipes and re-inserts on every sync, so any
 * hand-edit would be silently destroyed; surface a 422 instead. */
async function ensureManualAssignment(
  assignment_id: number,
): Promise<ActionResult<null>> {
  const [row] = await db
    .select({ source: assignment.source })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id))
    .limit(1);
  if (!row) return err("not_found", `assignment not found: ${assignment_id}`);
  if (row.source !== "manual") {
    return err(
      "validation_error",
      `assignment is auto-generated (source=${row.source}); edit the upstream awork booking instead`,
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
// Helpers
// ----------------------------------------------------------------------------

async function burdenFactorValue(): Promise<number> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, "burden_factor"));
  return row ? Number(row.value) : 1.0;
}

type EmployeeCost = { base: number | null; basis: string };

async function employeeMonthlyCostPreBurden(employee_id: number): Promise<EmployeeCost> {
  const [row] = await db
    .select({
      fix_salary: employeeCurrent.fix_salary,
      fix_salary_interval: employeeCurrent.fix_salary_interval,
      hourly_salary: employeeCurrent.hourly_salary,
      weekly_working_hours: employeeCurrent.weekly_working_hours,
    })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  if (!row) return { base: null, basis: "unknown employee" };
  const fix = row.fix_salary === null ? null : Number(row.fix_salary);
  const interval = row.fix_salary_interval;
  const hourly = row.hourly_salary === null ? null : Number(row.hourly_salary);
  const weekly = row.weekly_working_hours === null ? null : Number(row.weekly_working_hours);
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

async function resolveRate(
  project_id: number,
  framework_id: number | null,
  profile: string | null,
  as_of: string,
): Promise<{ rate: number | null; source: string }> {
  if (!profile) return { rate: null, source: "unset" };
  const pr = await db.execute(sql`
    SELECT daily_rate_eur FROM project_rate
    WHERE project_id = ${project_id} AND profile = ${profile} AND valid_from <= ${as_of}::date
    ORDER BY valid_from DESC LIMIT 1
  `);
  const prRow = (pr.rows as Array<{ daily_rate_eur: string }>)[0];
  if (prRow) return { rate: Number(prRow.daily_rate_eur), source: "project_rate" };
  if (framework_id !== null) {
    const fr = await db.execute(sql`
      SELECT daily_rate_eur FROM framework_rate
      WHERE framework_id = ${framework_id} AND profile = ${profile} AND valid_from <= ${as_of}::date
      ORDER BY valid_from DESC LIMIT 1
    `);
    const frRow = (fr.rows as Array<{ daily_rate_eur: string }>)[0];
    if (frRow) return { rate: Number(frRow.daily_rate_eur), source: "framework_rate" };
  }
  return { rate: null, source: "unset" };
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

  const projRes = await db.execute(sql`
    SELECT p.billing_model, p.framework_id, p.agreed_amount_eur,
           p.planned_start_date, p.planned_end_date, p.name AS project_name,
           c.name AS customer_name
    FROM project p JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.project_id = ${project_id}
  `);
  const projRow = (projRes.rows as Array<Record<string, unknown>>)[0];
  if (!projRow) return err("not_found", `project not found: ${project_id}`);

  const billing_model = projRow.billing_model as string;
  const framework_id = (projRow.framework_id as number | null) ?? null;
  const agreed_amount = projRow.agreed_amount_eur as string | null;
  const fp_start = (projRow.planned_start_date as string | null) ?? null;
  const fp_end = (projRow.planned_end_date as string | null) ?? null;
  const p_name = projRow.project_name as string;
  const c_name = projRow.customer_name as string;

  const burden = await burdenFactorValue();
  const as_of_date = as_of ?? new Date().toISOString().slice(0, 10);

  let effective_profile = profile ?? null;
  if (employee_id !== null && !effective_profile) {
    const tier = await db.execute(sql`
      SELECT role_tier FROM employee_role_tier WHERE employee_id = ${employee_id}
    `);
    const tRow = (tier.rows as Array<{ role_tier: string | null }>)[0];
    if (tRow) effective_profile = tRow.role_tier ?? null;
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
    const [flRow] = await db
      .select({ name: freelancer.name, daily_cost_eur: freelancer.daily_cost_eur })
      .from(freelancer)
      .where(eq(freelancer.freelancer_id, freelancer_id!));
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
    const r = await resolveRate(project_id, framework_id, effective_profile, as_of_date);
    effective_rate = r.rate;
    rate_source = r.source;
  }

  let fte_factor = 1.0;
  if (employee_id !== null) {
    const [row] = await db
      .select({ weekly_working_hours: employeeCurrent.weekly_working_hours })
      .from(employeeCurrent)
      .where(eq(employeeCurrent.employee_id, employee_id));
    if (row && row.weekly_working_hours) {
      fte_factor = Number(row.weekly_working_hours) / 40.0;
    }
  }

  let monthly_revenue: number | null = null;
  let monthly_margin: number | null = null;
  let margin_pct: number | null = null;
  if (billing_model === "time_and_material" && effective_rate !== null) {
    monthly_revenue =
      effective_rate * WORKING_DAYS_PER_MONTH * allocation_pct * fte_factor;
    if (monthly_cost !== null) {
      const allocated_cost = monthly_cost * allocation_pct;
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
    return err(
      "validation_error",
      "exactly one of employee_id, freelancer_id must be provided",
    );
  }
  if (end_date !== null && end_date < start_date) {
    return err("validation_error", "end_date must be on or after start_date");
  }

  const projExists = await db
    .select({ id: project.project_id })
    .from(project)
    .where(eq(project.project_id, project_id));
  if (projExists.length === 0) {
    return err("not_found", `project not found: ${project_id}`);
  }
  if (employee_id !== null) {
    const empExists = await db
      .select({ id: employeeCurrent.employee_id })
      .from(employeeCurrent)
      .where(eq(employeeCurrent.employee_id, employee_id));
    if (empExists.length === 0) {
      return err("not_found", `employee not found: ${employee_id}`);
    }
  }
  if (freelancer_id !== null) {
    const flExists = await db
      .select({ id: freelancer.freelancer_id })
      .from(freelancer)
      .where(eq(freelancer.freelancer_id, freelancer_id));
    if (flExists.length === 0) {
      return err("not_found", `freelancer not found: ${freelancer_id}`);
    }
  }
  if (freelancer_id !== null && !profile) {
    return err(
      "validation_error",
      "freelancer assignments require profile (no role_tier fallback)",
    );
  }

  const now = new Date();
  const [inserted] = await db
    .insert(assignment)
    .values({
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
      created_at: now,
      updated_at: now,
    })
    .returning({ assignment_id: assignment.assignment_id });

  const detail = await getAssignmentDetail(inserted.assignment_id);
  if (!detail) return err("internal_error", "created assignment not found");
  // Customer table reference kept alive for future joins (Drizzle pruning lint).
  void customer;
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
  const project_id = await projectIdOfAssignment(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const parsed = UpdateAssignmentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) return guard;

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
    if (!d) return err("not_found", `assignment not found: ${assignment_id}`);
    return ok(d);
  }
  updates.updated_at = new Date();
  await db
    .update(assignment)
    .set(updates)
    .where(eq(assignment.assignment_id, assignment_id));

  const d = await getAssignmentDetail(assignment_id);
  if (!d) return err("not_found", `assignment not found: ${assignment_id}`);
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
  const project_id = await projectIdOfAssignment(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const parsed = EndAssignmentSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) return guard;

  const [existing] = await db
    .select({ start_date: assignment.start_date })
    .from(assignment)
    .where(eq(assignment.assignment_id, assignment_id));
  if (!existing) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  if (parsed.data.end_date < existing.start_date!) {
    return err("validation_error", "end_date must be on or after start_date");
  }

  await db
    .update(assignment)
    .set({ end_date: parsed.data.end_date, updated_at: new Date() })
    .where(eq(assignment.assignment_id, assignment_id));

  const d = await getAssignmentDetail(assignment_id);
  if (!d) return err("not_found", `assignment not found: ${assignment_id}`);
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
  const project_id = await projectIdOfAssignment(assignment_id);
  if (project_id === null) {
    return err("not_found", `assignment not found: ${assignment_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const guard = await ensureManualAssignment(assignment_id);
  if (!guard.ok) return guard;
  await db
    .delete(assignment)
    .where(eq(assignment.assignment_id, assignment_id));
  return ok(null);
}
