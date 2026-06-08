"use server";

/** Phase E.6 — awork import builders.
 *
 * Composite mutations that build on the existing customer + project create
 * actions. Two flows:
 *   - importCustomerFromAworkAction: pick an awork company, create a
 *     customer (via createCustomerAction), wire up the company link.
 *   - importProjectFromAworkAction: pick an awork project, create a
 *     project (via createProjectAction) with optional billing/framework/
 *     name overrides + the awork project's time_budget, planned dates and
 *     status mapped in; wire up the project link.
 *
 * These call into the existing Phase C actions so all the same validation
 * (unique-name, billing model aliases, FP requires amount) applies.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  aworkCompany,
  aworkCompanyLink,
  aworkProject,
  aworkProjectLink,
  project,
} from "@/lib/db/schema";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";
import { createCustomerAction } from "./customer";
import { createProjectAction } from "./project";
import {
  getCustomerDetail,
  type CustomerDetail,
} from "@/lib/db/queries/customer";
import {
  getProjectDetail,
  type ProjectDetail,
} from "@/lib/db/queries/project";

// ----------------------------------------------------------------------------
// import_customer_from_awork
// ----------------------------------------------------------------------------

const ImportCustomerSchema = z.object({
  awork_company_id: z.string().min(1),
  name_override: z.string().nullable().optional(),
});

export async function importCustomerFromAworkAction(
  input: unknown,
): Promise<ActionResult<CustomerDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = ImportCustomerSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { awork_company_id, name_override } = parsed.data;

  const [co] = await db
    .select({ name: aworkCompany.name })
    .from(aworkCompany)
    .where(eq(aworkCompany.awork_company_id, awork_company_id));
  if (!co) {
    return err("not_found", `awork company not found: ${awork_company_id}`);
  }

  const existingLink = await db
    .select({ customer_id: aworkCompanyLink.customer_id })
    .from(aworkCompanyLink)
    .where(eq(aworkCompanyLink.awork_company_id, awork_company_id));
  if (existingLink.length > 0) {
    return err(
      "conflict",
      `awork company already linked to customer ${existingLink[0].customer_id}; unlink first if you want to re-import`,
    );
  }

  const name = (name_override ?? co.name ?? "").trim();
  if (!name) {
    return err(
      "validation_error",
      "awork company has no name and no override given",
    );
  }

  const created = await createCustomerAction({ name, notes: null });
  if (!created.ok) return created;

  await db.insert(aworkCompanyLink).values({
    awork_company_id,
    customer_id: created.data.customer_id,
    mapped_at: new Date(),
  });

  // Re-fetch the customer detail so any timing-sensitive fields land fresh.
  const detail = await getCustomerDetail(created.data.customer_id);
  if (!detail) {
    return err("internal_error", "created customer not found after import");
  }
  return ok(detail);
}

// ----------------------------------------------------------------------------
// import_project_from_awork
// ----------------------------------------------------------------------------

const ImportProjectSchema = z.object({
  awork_project_id: z.string().min(1),
  customer_id_override: z.number().int().nullable().optional(),
  framework_id_override: z.number().int().nullable().optional(),
  billing_model_override: z.string().nullable().optional(),
  name_override: z.string().nullable().optional(),
  agreed_amount_eur: z.number().nullable().optional(),
});

/** Lift the HTML-stripping helper from awork_link._strip_html into TS.
 * Same passes: drop closing block tags as newlines, drop everything else,
 * collapse runs of blank lines. */
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  let cleaned = html.replace(
    /<\/(p|li|h[1-6]|div|br\/?)\s*>/gi,
    "\n",
  );
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export async function importProjectFromAworkAction(
  input: unknown,
): Promise<ActionResult<ProjectDetail>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  const parsed = ImportProjectSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const {
    awork_project_id,
    customer_id_override = null,
    framework_id_override = null,
    billing_model_override = null,
    name_override = null,
    agreed_amount_eur = null,
  } = parsed.data;

  // Pull the awork side AND the company → customer link in one go.
  const [row] = await db
    .select({
      ap_name: aworkProject.name,
      ap_company_id: aworkProject.awork_company_id,
      ap_start: aworkProject.start_date,
      ap_due: aworkProject.due_date,
      ap_closed: aworkProject.closed_on,
      ap_time_budget_sec: aworkProject.time_budget_seconds,
      ap_status_type: aworkProject.project_status_type,
      ap_description: aworkProject.description,
      linked_customer_id: aworkCompanyLink.customer_id,
    })
    .from(aworkProject)
    .leftJoin(
      aworkCompanyLink,
      eq(aworkCompanyLink.awork_company_id, aworkProject.awork_company_id),
    )
    .where(eq(aworkProject.awork_project_id, awork_project_id));
  if (!row) {
    return err("not_found", `awork project not found: ${awork_project_id}`);
  }

  const existing = await db
    .select({ project_id: aworkProjectLink.project_id })
    .from(aworkProjectLink)
    .where(eq(aworkProjectLink.awork_project_id, awork_project_id));
  if (existing.length > 0) {
    return err(
      "conflict",
      `awork project already linked to project ${existing[0].project_id}`,
    );
  }

  const customer_id = customer_id_override ?? row.linked_customer_id ?? null;
  if (customer_id === null) {
    return err(
      "validation_error",
      `awork project's company (${row.ap_company_id}) is not linked to a customer. Import the company first, or pass customer_id_override.`,
    );
  }

  const billing_model = billing_model_override ?? "time_and_material";
  if (billing_model !== "time_and_material" && billing_model !== "fixed_price") {
    return err(
      "validation_error",
      `billing_model must be time_and_material or fixed_price (got ${JSON.stringify(billing_model)})`,
    );
  }

  const name = (name_override ?? row.ap_name ?? "").trim();
  if (!name) {
    return err(
      "validation_error",
      "awork project has no name and no override given",
    );
  }

  let our_status = "active";
  if (row.ap_status_type === "closed") our_status = "completed";
  else if (row.ap_status_type === "archived") our_status = "cancelled";

  const notes = stripHtml((row.ap_description as string | null) ?? null);

  const created = await createProjectAction({
    customer_id,
    name,
    billing_model,
    framework_id: framework_id_override,
    agreed_amount_eur,
    planned_start_date: row.ap_start ?? null,
    planned_end_date: row.ap_due ?? null,
    status: our_status,
    notes,
  });
  if (!created.ok) return created;

  // time_budget_hours doesn't go through createProjectAction (it's a
  // Phase B.4 addition). Patch it inline after create.
  if (row.ap_time_budget_sec !== null && row.ap_time_budget_sec !== undefined) {
    await db
      .update(project)
      .set({
        time_budget_hours: Math.floor(Number(row.ap_time_budget_sec) / 3600),
      })
      .where(eq(project.project_id, created.data.project_id));
  }

  await db.insert(aworkProjectLink).values({
    awork_project_id,
    project_id: created.data.project_id,
    mapped_at: new Date(),
  });

  // Note: also bind the awork-imported project to a closed (=ended)
  // assignment-derivation pass — that lives in the post-sync housekeeping
  // path on the Python side, not here. The basic create + link is enough
  // for the import dialog's contract.
  void row.ap_closed;

  const detail = await getProjectDetail(created.data.project_id);
  if (!detail) {
    return err("internal_error", "created project not found after import");
  }
  return ok(detail);
}
