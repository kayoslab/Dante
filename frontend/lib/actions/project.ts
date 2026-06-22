"use server";

import { z } from "zod";

import { audit } from "@/lib/auth/audit";
import {
  customerExists,
} from "@/lib/db/queries/customer";
import {
  deleteProject,
  deleteProjectAssignments,
  deleteProjectRate as deleteProjectRateRow,
  deleteProjectRates,
  deleteProjectSdm,
  findProjectByCustomerAndName,
  getAppUserRole,
  getFrameworkCustomerId,
  getProjectCustomerId,
  getProjectDetail,
  getProjectName,
  getProjectRate,
  getProjectRateDefaultValidFrom,
  insertProject,
  insertProjectRate,
  insertProjectSdm,
  listProjectAssignmentIds,
  listProjectRateKeys,
  mergeProjects,
  preflightMergeProjects,
  projectExists,
  updateProject,
  updateProjectRate as updateProjectRateRow,
  type ProjectDetail,
  type Rate,
  type MergeProjectsResult as QueryMergeProjectsResult,
} from "@/lib/db/queries/project";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";
import { requireProjectAccess } from "@/lib/auth/project-capability";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const BillingAliases: Record<string, string> = {
  "t-and-m": "time_and_material",
  tm: "time_and_material",
  time_and_material: "time_and_material",
  fp: "fixed_price",
  "fixed-price": "fixed_price",
  fixed_price: "fixed_price",
};

const CreateProjectSchema = z.object({
  customer_id: z.number().int(),
  name: z.string().min(1).max(200),
  billing_model: z.string(),
  framework_id: z.number().int().nullable().optional(),
  agreed_amount_eur: z.number().nullable().optional(),
  planned_start_date: IsoDate.nullable().optional(),
  planned_end_date: IsoDate.nullable().optional(),
  status: z.string().default("active"),
  notes: z.string().nullable().optional(),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  framework_id: z.number().int().nullable().optional(),
  clear_framework: z.boolean().optional(),
  agreed_amount_eur: z.number().nullable().optional(),
  planned_start_date: IsoDate.nullable().optional(),
  planned_end_date: IsoDate.nullable().optional(),
  status: z.string().optional(),
  notes: z.string().nullable().optional(),
});

const RateCreateSchema = z.object({
  profile: z.string().min(1).max(120),
  daily_rate_eur: z.number().positive(),
  valid_from: IsoDate.nullable().optional(),
});

const RateUpdateSchema = z.object({
  daily_rate_eur: z.number().positive(),
});

// ----------------------------------------------------------------------------
// Project CRUD
// ----------------------------------------------------------------------------

export async function createProjectAction(
  input: unknown,
): Promise<ActionResult<ProjectDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = CreateProjectSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await customerExists(parsed.data.customer_id))) {
    return err("not_found", `customer not found: ${parsed.data.customer_id}`);
  }

  const billing_model = BillingAliases[parsed.data.billing_model.toLowerCase()];
  if (!billing_model) {
    return err(
      "conflict",
      `billing_model must be one of t-and-m | fixed-price (or full names). Got: ${parsed.data.billing_model}`,
    );
  }
  if (
    billing_model === "fixed_price" &&
    (parsed.data.agreed_amount_eur === undefined ||
      parsed.data.agreed_amount_eur === null)
  ) {
    return err("conflict", "fixed-price projects require agreed_amount_eur");
  }

  if (parsed.data.framework_id !== null && parsed.data.framework_id !== undefined) {
    const fwCustomerId = await getFrameworkCustomerId(parsed.data.framework_id);
    if (fwCustomerId === null) {
      return err("not_found", `framework not found: ${parsed.data.framework_id}`);
    }
    if (fwCustomerId !== parsed.data.customer_id) {
      return err("conflict", "framework belongs to a different customer");
    }
  }

  const name = parsed.data.name.trim();
  if ((await findProjectByCustomerAndName(parsed.data.customer_id, name)) !== null) {
    return err("conflict", `project '${name}' already exists for this customer`);
  }

  let new_project_id: number;
  try {
    new_project_id = await insertProject({
      customer_id: parsed.data.customer_id,
      framework_id: parsed.data.framework_id ?? null,
      name,
      billing_model,
      agreed_amount_eur:
        parsed.data.agreed_amount_eur === null ||
        parsed.data.agreed_amount_eur === undefined
          ? null
          : String(parsed.data.agreed_amount_eur),
      planned_start_date: parsed.data.planned_start_date ?? null,
      planned_end_date: parsed.data.planned_end_date ?? null,
      status: parsed.data.status,
      notes: parsed.data.notes ?? null,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", `could not create project (unique violation)`);
    }
    throw e;
  }

  const detail = await getProjectDetail(new_project_id);
  if (!detail) return err("internal_error", "created project not found");
  return ok(detail);
}

export async function updateProjectAction(
  project_id: number,
  input: unknown,
): Promise<ActionResult<ProjectDetail>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;

  const parsed = UpdateProjectSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const currentCustomerId = await getProjectCustomerId(project_id);
  if (currentCustomerId === null) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
  if (parsed.data.clear_framework) {
    updates.framework_id = null;
  } else if (parsed.data.framework_id !== null && parsed.data.framework_id !== undefined) {
    const fwCustomerId = await getFrameworkCustomerId(parsed.data.framework_id);
    if (fwCustomerId === null) {
      return err("not_found", `framework not found: ${parsed.data.framework_id}`);
    }
    if (fwCustomerId !== currentCustomerId) {
      return err("conflict", "framework belongs to a different customer");
    }
    updates.framework_id = parsed.data.framework_id;
  }
  if (parsed.data.agreed_amount_eur !== undefined) {
    updates.agreed_amount_eur =
      parsed.data.agreed_amount_eur === null
        ? null
        : String(parsed.data.agreed_amount_eur);
  }
  if (parsed.data.planned_start_date !== undefined) {
    updates.planned_start_date = parsed.data.planned_start_date;
  }
  if (parsed.data.planned_end_date !== undefined) {
    updates.planned_end_date = parsed.data.planned_end_date;
  }
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  if (Object.keys(updates).length === 0) {
    const d = await getProjectDetail(project_id);
    if (!d) return err("not_found", `project not found: ${project_id}`);
    return ok(d);
  }

  try {
    await updateProject(project_id, updates);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err("conflict", "project name already exists for this customer");
    }
    throw e;
  }

  const detail = await getProjectDetail(project_id);
  if (!detail) return err("not_found", `project not found: ${project_id}`);
  return ok(detail);
}

export async function deleteProjectAction(
  project_id: number,
  force = false,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }

  const existingName = await getProjectName(project_id);
  if (existingName === null) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const rates = await listProjectRateKeys(project_id);
  const asns = await listProjectAssignmentIds(project_id);

  if ((rates.length > 0 || asns.length > 0) && !force) {
    return err(
      "has_children",
      `project '${existingName}' has ${rates.length} rate(s) and ${asns.length} assignment(s). Pass force=true to cascade.`,
    );
  }

  if (force) {
    if (asns.length > 0) {
      await deleteProjectAssignments(project_id);
    }
    if (rates.length > 0) {
      await deleteProjectRates(project_id);
    }
  }
  await deleteProject(project_id);
  return ok(null);
}

// ----------------------------------------------------------------------------
// Project rates
// ----------------------------------------------------------------------------

export async function addProjectRateAction(
  project_id: number,
  input: unknown,
): Promise<ActionResult<Rate>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;

  const parsed = RateCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  if (!(await projectExists(project_id))) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const profile = parsed.data.profile.trim();
  if (!profile) return err("conflict", "rate profile cannot be empty");
  const valid_from =
    parsed.data.valid_from ??
    (await getProjectRateDefaultValidFrom(project_id));

  const existing = await getProjectRate(project_id, profile, valid_from);
  if (existing !== null) {
    return err(
      "conflict",
      `rate for profile '${profile}' on this project effective ${valid_from} already exists (€${existing}/day)`,
    );
  }

  await insertProjectRate({
    project_id,
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });

  return ok({
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });
}

export async function updateProjectRateAction(
  project_id: number,
  profile: string,
  valid_from: string,
  input: unknown,
): Promise<ActionResult<Rate>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  if (!IsoDate.safeParse(valid_from).success) {
    return err("validation_error", "valid_from must be YYYY-MM-DD");
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;

  const parsed = RateUpdateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const existing = await getProjectRate(project_id, profile, valid_from);
  if (existing === null) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on project ${project_id} with valid_from ${valid_from}`,
    );
  }

  await updateProjectRateRow(
    project_id,
    profile,
    valid_from,
    String(parsed.data.daily_rate_eur),
  );

  return ok({
    profile,
    valid_from,
    daily_rate_eur: String(parsed.data.daily_rate_eur),
  });
}

export async function deleteProjectRateAction(
  project_id: number,
  profile: string,
  valid_from: string,
): Promise<ActionResult<null>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  if (!IsoDate.safeParse(valid_from).success) {
    return err("validation_error", "valid_from must be YYYY-MM-DD");
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;

  const existing = await getProjectRate(project_id, profile, valid_from);
  if (existing === null) {
    return err(
      "not_found",
      `no rate for profile '${profile}' on project ${project_id} with valid_from ${valid_from}`,
    );
  }
  await deleteProjectRateRow(project_id, profile, valid_from);
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

// ----------------------------------------------------------------------------
// Merge — fold one project's references into another and delete the source.
//
// Common case: the awork bulk import and a manual project creation both
// invent an internal project for the same engagement, so the same customer
// engagement ends up split across two `project` rows. Rather than asking
// the operator to fix this in psql every time, merge moves assignments,
// rates, and Personio/awork link rows over and deletes the source row in
// one transaction.
//
// Conflict resolution on `project_rate`: PK is (project_id, profile,
// valid_from). When the source has a rate that collides with an existing
// target rate, the source row is dropped (target wins). Document this
// in the dialog so the operator picks the target accordingly.
// ----------------------------------------------------------------------------

const MergeSchema = z.object({
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  /** Require the operator to acknowledge that this destroys data. */
  confirm: z.literal(true),
});

export type MergeProjectsResult = QueryMergeProjectsResult;

export async function mergeProjectsAction(
  input: unknown,
): Promise<ActionResult<MergeProjectsResult>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = MergeSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { source_project_id, target_project_id } = parsed.data;

  if (source_project_id === target_project_id) {
    return err("validation_error", "Source and target must differ.");
  }

  const preflight = await preflightMergeProjects(
    source_project_id,
    target_project_id,
  );
  if (!preflight.ok) {
    return err("not_found", "Source or target project not found.");
  }

  const result = await mergeProjects(source_project_id, target_project_id);

  await audit(auth.ctx, {
    action: "project_merged",
    target_type: "project",
    target_id: `${source_project_id}->${target_project_id}`,
  });

  return ok(result);
}

// ----------------------------------------------------------------------------
// Service Delivery Manager grants — admin-only mutations.
//
// SDM grants are intentionally bypassed by the project capability check
// for admin/manager roles. The two actions below are the ONLY way the
// `project_sdm` table is written from app code.
// ----------------------------------------------------------------------------

const GrantSdmSchema = z.object({
  project_id: z.number().int().positive(),
  user_id: z.string().uuid(),
});

const RevokeSdmSchema = GrantSdmSchema;

export async function grantProjectSdmAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;

  const parsed = GrantSdmSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { project_id, user_id } = parsed.data;

  // Sanity: both must exist. Granting on a deleted/missing target is a
  // foot-gun even though the FK would catch it — the error message is
  // friendlier here.
  if (!(await projectExists(project_id))) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const role = await getAppUserRole(user_id);
  if (role === null) return err("not_found", `user not found: ${user_id}`);
  if (role !== "employee") {
    return err(
      "validation_error",
      "Only employee-role users need SDM grants — admin/manager already have project access.",
    );
  }

  await insertProjectSdm({
    project_id,
    user_id,
    granted_by: auth.ctx.user_id,
  });

  await audit(auth.ctx, {
    action: "project_sdm_granted",
    target_type: "project",
    target_id: `${project_id}/${user_id}`,
  });

  return ok(null);
}

export async function revokeProjectSdmAction(
  input: unknown,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;

  const parsed = RevokeSdmSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { project_id, user_id } = parsed.data;

  await deleteProjectSdm(project_id, user_id);

  await audit(auth.ctx, {
    action: "project_sdm_revoked",
    target_type: "project",
    target_id: `${project_id}/${user_id}`,
  });

  return ok(null);
}
