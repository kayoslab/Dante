"use server";

import { z } from "zod";

import {
  customerExists,
  deleteAworkCompanyLink,
  getAworkCompanyLinkCustomerId,
  getAworkCompanyName,
  insertAworkCompanyLink,
} from "@/lib/db/queries/customer";
import {
  deleteAworkUserLink,
  employeeExists,
  getAworkUserLinkEmployeeId,
  getAworkUserName,
  insertAworkUserLink,
} from "@/lib/db/queries/employee";
import {
  deleteAworkProjectLink,
  deletePersonioProjectLink,
  getAworkProjectLinkProjectId,
  getAworkProjectName,
  getPersonioLinkProjectId,
  getPersonioProjectName,
  insertAworkProjectLink,
  insertPersonioProjectLink,
  projectExists,
} from "@/lib/db/queries/project";
import {
  getSettingDescription,
  upsertSetting,
} from "@/lib/db/queries/setting";
import { audit } from "@/lib/auth/audit";

import {
  err,
  fromZod,
  ok,
  requireActionRole,
  type ActionResult,
} from "./_action-helpers";
import { requireProjectAccess } from "@/lib/auth/project-capability";

// ----------------------------------------------------------------------------
// personioProjectLink
// ----------------------------------------------------------------------------

export type PersonioProjectItem = {
  personio_project_id: number;
  name: string;
  mapped_to_project_id: number;
};

const PersonioLinkCreateSchema = z.object({
  personio_project_id: z.number().int(),
});

export async function createPersonioLinkAction(
  project_id: number,
  input: unknown,
): Promise<ActionResult<PersonioProjectItem>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const parsed = PersonioLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const personio_project_id = parsed.data.personio_project_id;

  if (!(await projectExists(project_id))) {
    await audit(ctx, {
      action: "project_personio_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${personio_project_id}`,
    });
    return err("not_found", `project not found: ${project_id}`);
  }

  const pp_name = await getPersonioProjectName(personio_project_id);
  if (pp_name === null) {
    await audit(ctx, {
      action: "project_personio_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${personio_project_id}`,
    });
    return err(
      "not_found",
      `personio project not found: ${personio_project_id}. Run \`dante sync\` to refresh the list.`,
    );
  }

  const existingProjectId = await getPersonioLinkProjectId(personio_project_id);
  if (existingProjectId !== null) {
    if (existingProjectId !== project_id) {
      await audit(ctx, {
        action: "project_personio_link_created_denied",
        target_type: "project",
        target_id: `${project_id}/${personio_project_id}`,
      });
      return err(
        "conflict",
        `personio project ${personio_project_id} '${pp_name}' is already linked to project ${existingProjectId}. Unlink it first.`,
      );
    }
    await audit(ctx, {
      action: "project_personio_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${personio_project_id}`,
    });
    return err(
      "conflict",
      `personio project ${personio_project_id} already linked here`,
    );
  }

  await insertPersonioProjectLink({ personio_project_id, project_id });
  await audit(ctx, {
    action: "project_personio_link_created",
    target_type: "project",
    target_id: `${project_id}/${personio_project_id}`,
  });
  return ok({
    personio_project_id,
    name: pp_name,
    mapped_to_project_id: project_id,
  });
}

export async function deletePersonioLinkAction(
  project_id: number,
  personio_project_id: number,
): Promise<ActionResult<null>> {
  if (!Number.isInteger(project_id) || !Number.isInteger(personio_project_id)) {
    return err("validation_error", "invalid id(s)");
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const removed = await deletePersonioProjectLink(
    project_id,
    personio_project_id,
  );
  if (removed === 0) {
    await audit(ctx, {
      action: "project_personio_link_removed_denied",
      target_type: "project",
      target_id: `${project_id}/${personio_project_id}`,
    });
    return err(
      "not_found",
      `no link from personio project ${personio_project_id} to project ${project_id}`,
    );
  }
  await audit(ctx, {
    action: "project_personio_link_removed",
    target_type: "project",
    target_id: `${project_id}/${personio_project_id}`,
  });
  return ok(null);
}

// ----------------------------------------------------------------------------
// aworkProjectLink
// ----------------------------------------------------------------------------

export type AworkProjectItem = {
  awork_project_id: string;
  name: string | null;
  mapped_to_project_id: number;
};

const AworkProjectLinkCreateSchema = z.object({
  awork_project_id: z.string().min(1),
});

export async function createAworkProjectLinkAction(
  project_id: number,
  input: unknown,
): Promise<ActionResult<AworkProjectItem>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const parsed = AworkProjectLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const awork_project_id = parsed.data.awork_project_id;

  if (!(await projectExists(project_id))) {
    await audit(ctx, {
      action: "project_awork_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${awork_project_id}`,
    });
    return err("not_found", `project not found: ${project_id}`);
  }

  const ap_name = await getAworkProjectName(awork_project_id);
  if (ap_name === null) {
    await audit(ctx, {
      action: "project_awork_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${awork_project_id}`,
    });
    return err(
      "not_found",
      `awork project not found: ${awork_project_id}. Run \`dante awork sync\` to refresh the catalog.`,
    );
  }

  const existingProjectId = await getAworkProjectLinkProjectId(awork_project_id);
  if (existingProjectId !== null) {
    if (existingProjectId !== project_id) {
      await audit(ctx, {
        action: "project_awork_link_created_denied",
        target_type: "project",
        target_id: `${project_id}/${awork_project_id}`,
      });
      return err(
        "conflict",
        `awork project ${awork_project_id} '${ap_name ?? ""}' is already linked to project ${existingProjectId}. Unlink it first.`,
      );
    }
    await audit(ctx, {
      action: "project_awork_link_created_denied",
      target_type: "project",
      target_id: `${project_id}/${awork_project_id}`,
    });
    return err("conflict", `awork project ${awork_project_id} already linked here`);
  }

  await insertAworkProjectLink({ awork_project_id, project_id });
  await audit(ctx, {
    action: "project_awork_link_created",
    target_type: "project",
    target_id: `${project_id}/${awork_project_id}`,
  });
  return ok({
    awork_project_id,
    name: ap_name,
    mapped_to_project_id: project_id,
  });
}

export async function deleteAworkProjectLinkAction(
  project_id: number,
  awork_project_id: string,
): Promise<ActionResult<null>> {
  if (!Number.isInteger(project_id)) {
    return err("validation_error", `invalid project id: ${project_id}`);
  }
  const auth = await requireProjectAccess(project_id);
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  const removed = await deleteAworkProjectLink(project_id, awork_project_id);
  if (removed === 0) {
    await audit(ctx, {
      action: "project_awork_link_removed_denied",
      target_type: "project",
      target_id: `${project_id}/${awork_project_id}`,
    });
    return err(
      "not_found",
      `no link from awork project ${awork_project_id} to project ${project_id}`,
    );
  }
  await audit(ctx, {
    action: "project_awork_link_removed",
    target_type: "project",
    target_id: `${project_id}/${awork_project_id}`,
  });
  return ok(null);
}

// ----------------------------------------------------------------------------
// aworkUserLink
// ----------------------------------------------------------------------------

export type AworkUserItem = {
  awork_user_id: string;
  first_name: string | null;
  last_name: string | null;
  mapped_to_employee_id: number;
};

const AworkUserLinkCreateSchema = z.object({
  awork_user_id: z.string().min(1),
});

export async function createAworkUserLinkAction(
  employee_id: number,
  input: unknown,
): Promise<ActionResult<AworkUserItem>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(employee_id)) {
    return err("validation_error", `invalid employee id: ${employee_id}`);
  }
  const parsed = AworkUserLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const awork_user_id = parsed.data.awork_user_id;

  if (!(await employeeExists(employee_id))) {
    return err("not_found", `employee not found: ${employee_id}`);
  }

  const au = await getAworkUserName(awork_user_id);
  if (au === null) {
    return err(
      "not_found",
      `awork user not found: ${awork_user_id}. Run \`dante awork sync\` to refresh.`,
    );
  }

  const existingEmployeeId = await getAworkUserLinkEmployeeId(awork_user_id);
  if (existingEmployeeId !== null) {
    if (existingEmployeeId !== employee_id) {
      const fn = au.first_name ?? "";
      const ln = au.last_name ?? "";
      return err(
        "conflict",
        `awork user ${awork_user_id} (${fn} ${ln}) is already linked to employee ${existingEmployeeId}. Unlink it first.`,
      );
    }
    return err("conflict", "already linked");
  }

  await insertAworkUserLink({ awork_user_id, employee_id });
  return ok({
    awork_user_id,
    first_name: au.first_name,
    last_name: au.last_name,
    mapped_to_employee_id: employee_id,
  });
}

export async function deleteAworkUserLinkAction(
  employee_id: number,
  awork_user_id: string,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(employee_id)) {
    return err("validation_error", `invalid employee id: ${employee_id}`);
  }
  const removed = await deleteAworkUserLink(employee_id, awork_user_id);
  if (removed === 0) {
    return err(
      "not_found",
      `no link from awork user ${awork_user_id} to employee ${employee_id}`,
    );
  }
  return ok(null);
}

// ----------------------------------------------------------------------------
// awork_company_link
// ----------------------------------------------------------------------------

export type AworkCompanyLinkItem = {
  awork_company_id: string;
  name: string | null;
  mapped_to_customer_id: number;
};

const AworkCompanyLinkCreateSchema = z.object({
  awork_company_id: z.string().min(1),
});

export async function createAworkCompanyLinkAction(
  customer_id: number,
  input: unknown,
): Promise<ActionResult<AworkCompanyLinkItem>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const parsed = AworkCompanyLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const awork_company_id = parsed.data.awork_company_id;

  if (!(await customerExists(customer_id))) {
    await audit(ctx, {
      action: "customer_awork_link_created_denied",
      target_type: "customer",
      target_id: `${customer_id}/${awork_company_id}`,
    });
    return err("not_found", `customer not found: ${customer_id}`);
  }
  const co_name = await getAworkCompanyName(awork_company_id);
  if (co_name === null) {
    await audit(ctx, {
      action: "customer_awork_link_created_denied",
      target_type: "customer",
      target_id: `${customer_id}/${awork_company_id}`,
    });
    return err("not_found", `awork company not found: ${awork_company_id}`);
  }
  const existingCustomerId =
    await getAworkCompanyLinkCustomerId(awork_company_id);
  if (existingCustomerId !== null) {
    if (existingCustomerId !== customer_id) {
      await audit(ctx, {
        action: "customer_awork_link_created_denied",
        target_type: "customer",
        target_id: `${customer_id}/${awork_company_id}`,
      });
      return err(
        "conflict",
        `awork company ${awork_company_id} '${co_name ?? ""}' is already linked to customer ${existingCustomerId}`,
      );
    }
    await audit(ctx, {
      action: "customer_awork_link_created_denied",
      target_type: "customer",
      target_id: `${customer_id}/${awork_company_id}`,
    });
    return err("conflict", "already linked here");
  }
  await insertAworkCompanyLink({ awork_company_id, customer_id });
  await audit(ctx, {
    action: "customer_awork_link_created",
    target_type: "customer",
    target_id: `${customer_id}/${awork_company_id}`,
  });
  return ok({
    awork_company_id,
    name: co_name,
    mapped_to_customer_id: customer_id,
  });
}

export async function deleteAworkCompanyLinkAction(
  customer_id: number,
  awork_company_id: string,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;
  const ctx = auth.ctx;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const removed = await deleteAworkCompanyLink(customer_id, awork_company_id);
  if (removed === 0) {
    await audit(ctx, {
      action: "customer_awork_link_removed_denied",
      target_type: "customer",
      target_id: `${customer_id}/${awork_company_id}`,
    });
    return err(
      "not_found",
      `no link from awork company ${awork_company_id} to customer ${customer_id}`,
    );
  }
  await audit(ctx, {
    action: "customer_awork_link_removed",
    target_type: "customer",
    target_id: `${customer_id}/${awork_company_id}`,
  });
  return ok(null);
}

// ----------------------------------------------------------------------------
// setting upsert
// ----------------------------------------------------------------------------

export type SettingItem = {
  key: string;
  value: string;
  description: string | null;
  updated_at: string | null;
};

const SettingUpdateSchema = z.object({
  value: z.string(),
  description: z.string().nullable().optional(),
});

export async function putSettingAction(
  key: string,
  input: unknown,
): Promise<ActionResult<SettingItem>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;

  if (!key) return err("validation_error", "key is required");
  const parsed = SettingUpdateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  // Preserve existing description when not explicitly provided — same
  // behavior as the Python service so an FE that only sends `value` keeps
  // the explanatory text intact.
  let description: string | null = parsed.data.description ?? null;
  if (parsed.data.description === undefined || parsed.data.description === null) {
    description = await getSettingDescription(key);
  }

  const row = await upsertSetting({
    key,
    value: parsed.data.value,
    description,
    updated_at: new Date(),
  });
  if (!row) return err("internal_error", "setting upsert vanished");
  return ok({
    key: row.key,
    value: row.value,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
  });
}
