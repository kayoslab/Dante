"use server";

/** Links between external records and Dante entities, and imports of
 * external records into Dante — generic over every integration.
 *
 * A link is (integration, entity type, external id) → (Dante type, Dante
 * id). Access follows the Dante side: project links need project access
 * (admin / manager, or an SDM grant on that project); employee, freelancer
 * and customer links need manager. Creating a project link seeds the Dante
 * project's billability from the source's flag when the source says
 * non-billable (overridable afterwards), as the per-provider actions did.
 */
import { z } from "zod";

import { audit } from "@/lib/auth/audit";
import { requireProjectAccess } from "@/lib/auth/project-capability";
import { customerExists, getCustomerDetail, type CustomerDetail } from "@/lib/db/queries/customer";
import { employeeExists } from "@/lib/db/queries/employee";
import {
  deleteExternalLink,
  getExternalRecord,
  getLinkTarget,
  getProjectImportContext,
  insertExternalLink,
} from "@/lib/db/queries/external-records";
import { getIntegration } from "@/lib/db/queries/integration";
import {
  getProjectDetail,
  projectExists,
  setProjectTimeBudgetHours,
  updateProject,
  type ProjectDetail,
} from "@/lib/db/queries/project";
import {
  LINK_TARGETS,
  type DanteEntityType,
  type ExternalEntityType,
} from "@/lib/integrations/core/capabilities";
import { projectStatusFromSource, stripHtml } from "@/lib/integrations/core/import";

import { err, fromZod, ok, requireActionRole, type ActionAuth, type ActionResult } from "./_action-helpers";
import { createCustomerAction } from "./customer";
import { createProjectAction } from "./project";

const LinkSchema = z.object({
  integration_slug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  entity_type: z.enum(["person", "project", "company"]),
  external_id: z.string().min(1),
  dante_type: z.enum(["employee", "freelancer", "project", "customer"]),
  dante_id: z.number().int(),
});
export type LinkInput = z.infer<typeof LinkSchema>;

async function authorise(dante_type: DanteEntityType, dante_id: number): Promise<ActionAuth> {
  if (dante_type === "project") return requireProjectAccess(dante_id);
  return requireActionRole("manager");
}

async function danteEntityExists(dante_type: DanteEntityType, dante_id: number): Promise<boolean> {
  switch (dante_type) {
    case "project":
      return projectExists(dante_id);
    case "employee":
      return employeeExists(dante_id);
    case "customer":
      return customerExists(dante_id);
    case "freelancer":
      return true; // validated by the FK-less link only; freelancer links are created by the sync
  }
}

export type LinkResult = LinkInput & { name: string | null };

export async function createExternalLinkAction(input: unknown): Promise<ActionResult<LinkResult>> {
  const parsed = LinkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const link = parsed.data;
  const auth = await authorise(link.dante_type, link.dante_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;
  const target = `${link.dante_type}:${link.dante_id}`;
  const denied = async (detail: string, code: "not_found" | "conflict" | "validation_error") => {
    await audit(ctx, { action: "external_link_created_denied", target_type: link.dante_type, target_id: `${link.dante_id}/${link.integration_slug}:${link.external_id}` });
    return err(code, detail);
  };

  if (!(LINK_TARGETS[link.entity_type as ExternalEntityType] as readonly string[]).includes(link.dante_type)) {
    return denied(`a ${link.entity_type} cannot be linked to a ${link.dante_type}`, "validation_error");
  }
  const integration = await getIntegration(link.integration_slug);
  if (!integration) return denied(`integration "${link.integration_slug}" is not configured`, "not_found");
  if (!(await danteEntityExists(link.dante_type, link.dante_id))) {
    return denied(`${link.dante_type} not found: ${link.dante_id}`, "not_found");
  }
  const record = await getExternalRecord(link.integration_slug, link.entity_type, link.external_id);
  if (!record) {
    return denied(
      `${integration.display_name} ${link.entity_type} not found: ${link.external_id}. Run a sync to refresh the catalog.`,
      "not_found",
    );
  }
  const existing = await getLinkTarget(link.integration_slug, link.entity_type, link.external_id);
  if (existing) {
    if (existing.dante_type === link.dante_type && existing.dante_id === link.dante_id) {
      return denied("already linked here", "conflict");
    }
    return denied(
      `${integration.display_name} ${link.entity_type} "${record.name ?? link.external_id}" is already linked to ${existing.dante_type} ${existing.dante_id}. Unlink it first.`,
      "conflict",
    );
  }

  await insertExternalLink(link);
  // Seed the Dante project's billability from the source: a non-billable
  // source project forces the Dante project non-billable (overridable);
  // true / unknown leaves the default untouched.
  if (link.dante_type === "project" && record.billable === false) {
    await updateProject(link.dante_id, { billable: false });
  }
  await audit(ctx, {
    action: "external_link_created",
    target_type: link.dante_type,
    target_id: `${link.dante_id}/${link.integration_slug}:${link.external_id}`,
  });
  void target;
  return ok({ ...link, name: record.name });
}

export async function deleteExternalLinkAction(input: unknown): Promise<ActionResult<null>> {
  const parsed = LinkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const link = parsed.data;
  const auth = await authorise(link.dante_type, link.dante_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const removed = await deleteExternalLink(link);
  if (removed === 0) {
    await audit(ctx, {
      action: "external_link_removed_denied",
      target_type: link.dante_type,
      target_id: `${link.dante_id}/${link.integration_slug}:${link.external_id}`,
    });
    return err("not_found", `no link from ${link.integration_slug} ${link.entity_type} ${link.external_id} to ${link.dante_type} ${link.dante_id}`);
  }
  await audit(ctx, {
    action: "external_link_removed",
    target_type: link.dante_type,
    target_id: `${link.dante_id}/${link.integration_slug}:${link.external_id}`,
  });
  return ok(null);
}

// ---------------------------------------------------------------------------
// Imports: create a Dante entity from an external record and link it
// ---------------------------------------------------------------------------

const ImportCustomerSchema = z.object({
  integration_slug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  external_id: z.string().min(1),
  name_override: z.string().nullable().optional(),
});

export async function importCustomerFromSourceAction(
  input: unknown,
): Promise<ActionResult<CustomerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const parsed = ImportCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { integration_slug, external_id, name_override } = parsed.data;

  const record = await getExternalRecord(integration_slug, "company", external_id);
  if (!record) return err("not_found", `company not found: ${integration_slug} ${external_id}`);
  const existing = await getLinkTarget(integration_slug, "company", external_id);
  if (existing) {
    return err("conflict", `company already linked to customer ${existing.dante_id}; unlink first if you want to re-import`);
  }
  const name = (name_override ?? record.name ?? "").trim();
  if (!name) return err("validation_error", "company has no name and no override given");

  const created = await createCustomerAction({ name, notes: null });
  if (!created.ok) return created;
  await insertExternalLink({
    integration_slug,
    entity_type: "company",
    external_id,
    dante_type: "customer",
    dante_id: created.data.customer_id,
  });
  await audit(auth.ctx, {
    action: "external_customer_imported",
    target_type: "customer",
    target_id: `${created.data.customer_id}/${integration_slug}:${external_id}`,
  });
  const detail = await getCustomerDetail(created.data.customer_id);
  if (!detail) return err("internal_error", "created customer not found after import");
  return ok(detail);
}

const ImportProjectSchema = z.object({
  integration_slug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  external_id: z.string().min(1),
  customer_id_override: z.number().int().nullable().optional(),
  framework_id_override: z.number().int().nullable().optional(),
  billing_model_override: z.string().nullable().optional(),
  name_override: z.string().nullable().optional(),
  agreed_amount_eur: z.number().nullable().optional(),
});

export async function importProjectFromSourceAction(
  input: unknown,
): Promise<ActionResult<ProjectDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const parsed = ImportProjectSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const {
    integration_slug,
    external_id,
    customer_id_override = null,
    framework_id_override = null,
    billing_model_override = null,
    name_override = null,
    agreed_amount_eur = null,
  } = parsed.data;
  const denied = async (detail: string, code: "not_found" | "conflict" | "validation_error") => {
    await audit(auth.ctx, { action: "external_project_imported_denied", target_type: "project", target_id: `${integration_slug}:${external_id}` });
    return err(code, detail);
  };

  const row = await getProjectImportContext(integration_slug, external_id);
  if (!row) return denied(`project not found: ${integration_slug} ${external_id}`, "not_found");
  const existing = await getLinkTarget(integration_slug, "project", external_id);
  if (existing) return denied(`project already linked to project ${existing.dante_id}`, "conflict");

  const customer_id = customer_id_override ?? row.linked_customer_id ?? null;
  if (customer_id === null) {
    return denied(
      `the project's company (${row.external_company_id ?? "none"}) is not linked to a customer. Import the company first, or pass customer_id_override.`,
      "validation_error",
    );
  }
  const billing_model = billing_model_override ?? "time_and_material";
  if (billing_model !== "time_and_material" && billing_model !== "fixed_price") {
    return denied(`billing_model must be time_and_material or fixed_price (got ${JSON.stringify(billing_model)})`, "validation_error");
  }
  const name = (name_override ?? row.name ?? "").trim();
  if (!name) return denied("project has no name and no override given", "validation_error");

  const created = await createProjectAction({
    customer_id,
    name,
    billing_model,
    framework_id: framework_id_override,
    agreed_amount_eur,
    planned_start_date: row.start_date,
    planned_end_date: row.due_date,
    status: projectStatusFromSource(row.status_type),
    notes: stripHtml(row.description),
  });
  if (!created.ok) {
    await audit(auth.ctx, { action: "external_project_imported_denied", target_type: "project", target_id: `${integration_slug}:${external_id}` });
    return created;
  }
  if (row.time_budget_seconds !== null) {
    await setProjectTimeBudgetHours(created.data.project_id, Math.floor(row.time_budget_seconds / 3600));
  }
  if (row.billable === false) {
    await updateProject(created.data.project_id, { billable: false });
  }
  await insertExternalLink({
    integration_slug,
    entity_type: "project",
    external_id,
    dante_type: "project",
    dante_id: created.data.project_id,
  });
  const detail = await getProjectDetail(created.data.project_id);
  if (!detail) return err("internal_error", "created project not found after import");
  await audit(auth.ctx, {
    action: "external_project_imported",
    target_type: "project",
    target_id: `${created.data.project_id}/${integration_slug}:${external_id}`,
  });
  return ok(detail);
}
