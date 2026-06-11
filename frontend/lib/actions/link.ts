"use server";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  aworkCompany,
  aworkCompanyLink,
  aworkProject,
  aworkProjectLink,
  aworkUser,
  aworkUserLink,
  customer,
  employeeCurrent,
  personioProject,
  personioProjectLink,
  project,
  setting,
} from "@/lib/db/schema";

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

  const parsed = PersonioLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const personio_project_id = parsed.data.personio_project_id;

  const proj = await db
    .select({ id: project.project_id })
    .from(project)
    .where(eq(project.project_id, project_id));
  if (proj.length === 0) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const [pp] = await db
    .select({ name: personioProject.name })
    .from(personioProject)
    .where(eq(personioProject.personio_project_id, personio_project_id));
  if (!pp) {
    return err(
      "not_found",
      `personio project not found: ${personio_project_id}. Run \`dante sync\` to refresh the list.`,
    );
  }

  const existing = await db
    .select({ project_id: personioProjectLink.project_id })
    .from(personioProjectLink)
    .where(eq(personioProjectLink.personio_project_id, personio_project_id));
  if (existing.length > 0) {
    if (existing[0].project_id !== project_id) {
      return err(
        "conflict",
        `personio project ${personio_project_id} '${pp.name}' is already linked to project ${existing[0].project_id}. Unlink it first.`,
      );
    }
    return err(
      "conflict",
      `personio project ${personio_project_id} already linked here`,
    );
  }

  await db.insert(personioProjectLink).values({
    personio_project_id,
    project_id,
    mapped_at: new Date(),
  });
  return ok({
    personio_project_id,
    name: pp.name,
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

  const existing = await db
    .select({ id: personioProjectLink.personio_project_id })
    .from(personioProjectLink)
    .where(
      and(
        eq(personioProjectLink.personio_project_id, personio_project_id),
        eq(personioProjectLink.project_id, project_id),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no link from personio project ${personio_project_id} to project ${project_id}`,
    );
  }
  await db
    .delete(personioProjectLink)
    .where(
      and(
        eq(personioProjectLink.personio_project_id, personio_project_id),
        eq(personioProjectLink.project_id, project_id),
      ),
    );
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

  const parsed = AworkProjectLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const awork_project_id = parsed.data.awork_project_id;

  const proj = await db
    .select({ id: project.project_id })
    .from(project)
    .where(eq(project.project_id, project_id));
  if (proj.length === 0) {
    return err("not_found", `project not found: ${project_id}`);
  }

  const [ap] = await db
    .select({ name: aworkProject.name })
    .from(aworkProject)
    .where(eq(aworkProject.awork_project_id, awork_project_id));
  if (!ap) {
    return err(
      "not_found",
      `awork project not found: ${awork_project_id}. Run \`dante awork sync\` to refresh the catalog.`,
    );
  }

  const existing = await db
    .select({ project_id: aworkProjectLink.project_id })
    .from(aworkProjectLink)
    .where(eq(aworkProjectLink.awork_project_id, awork_project_id));
  if (existing.length > 0) {
    if (existing[0].project_id !== project_id) {
      return err(
        "conflict",
        `awork project ${awork_project_id} '${ap.name ?? ""}' is already linked to project ${existing[0].project_id}. Unlink it first.`,
      );
    }
    return err("conflict", `awork project ${awork_project_id} already linked here`);
  }

  await db.insert(aworkProjectLink).values({
    awork_project_id,
    project_id,
    mapped_at: new Date(),
  });
  return ok({
    awork_project_id,
    name: ap.name,
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

  const existing = await db
    .select({ id: aworkProjectLink.awork_project_id })
    .from(aworkProjectLink)
    .where(
      and(
        eq(aworkProjectLink.awork_project_id, awork_project_id),
        eq(aworkProjectLink.project_id, project_id),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no link from awork project ${awork_project_id} to project ${project_id}`,
    );
  }
  await db
    .delete(aworkProjectLink)
    .where(
      and(
        eq(aworkProjectLink.awork_project_id, awork_project_id),
        eq(aworkProjectLink.project_id, project_id),
      ),
    );
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

  const emp = await db
    .select({ id: employeeCurrent.employee_id })
    .from(employeeCurrent)
    .where(eq(employeeCurrent.employee_id, employee_id));
  if (emp.length === 0) {
    return err("not_found", `employee not found: ${employee_id}`);
  }

  const [au] = await db
    .select({ first_name: aworkUser.first_name, last_name: aworkUser.last_name })
    .from(aworkUser)
    .where(eq(aworkUser.awork_user_id, awork_user_id));
  if (!au) {
    return err(
      "not_found",
      `awork user not found: ${awork_user_id}. Run \`dante awork sync\` to refresh.`,
    );
  }

  const existing = await db
    .select({ employee_id: aworkUserLink.employee_id })
    .from(aworkUserLink)
    .where(eq(aworkUserLink.awork_user_id, awork_user_id));
  if (existing.length > 0) {
    if (existing[0].employee_id !== employee_id) {
      const fn = au.first_name ?? "";
      const ln = au.last_name ?? "";
      return err(
        "conflict",
        `awork user ${awork_user_id} (${fn} ${ln}) is already linked to employee ${existing[0].employee_id}. Unlink it first.`,
      );
    }
    return err("conflict", "already linked");
  }

  await db.insert(aworkUserLink).values({
    awork_user_id,
    employee_id,
    mapped_at: new Date(),
  });
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
  const existing = await db
    .select({ id: aworkUserLink.awork_user_id })
    .from(aworkUserLink)
    .where(
      and(
        eq(aworkUserLink.awork_user_id, awork_user_id),
        eq(aworkUserLink.employee_id, employee_id),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no link from awork user ${awork_user_id} to employee ${employee_id}`,
    );
  }
  await db
    .delete(aworkUserLink)
    .where(
      and(
        eq(aworkUserLink.awork_user_id, awork_user_id),
        eq(aworkUserLink.employee_id, employee_id),
      ),
    );
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

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const parsed = AworkCompanyLinkCreateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const awork_company_id = parsed.data.awork_company_id;

  const cust = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  if (cust.length === 0) {
    return err("not_found", `customer not found: ${customer_id}`);
  }
  const [co] = await db
    .select({ name: aworkCompany.name })
    .from(aworkCompany)
    .where(eq(aworkCompany.awork_company_id, awork_company_id));
  if (!co) {
    return err("not_found", `awork company not found: ${awork_company_id}`);
  }
  const existing = await db
    .select({ customer_id: aworkCompanyLink.customer_id })
    .from(aworkCompanyLink)
    .where(eq(aworkCompanyLink.awork_company_id, awork_company_id));
  if (existing.length > 0) {
    if (existing[0].customer_id !== customer_id) {
      return err(
        "conflict",
        `awork company ${awork_company_id} '${co.name ?? ""}' is already linked to customer ${existing[0].customer_id}`,
      );
    }
    return err("conflict", "already linked here");
  }
  await db.insert(aworkCompanyLink).values({
    awork_company_id,
    customer_id,
    mapped_at: new Date(),
  });
  return ok({
    awork_company_id,
    name: co.name,
    mapped_to_customer_id: customer_id,
  });
}

export async function deleteAworkCompanyLinkAction(
  customer_id: number,
  awork_company_id: string,
): Promise<ActionResult<null>> {
  const auth = await requireActionRole("manager");
  if (!auth.ok) return auth.result;

  if (!Number.isInteger(customer_id)) {
    return err("validation_error", `invalid customer id: ${customer_id}`);
  }
  const existing = await db
    .select({ id: aworkCompanyLink.awork_company_id })
    .from(aworkCompanyLink)
    .where(
      and(
        eq(aworkCompanyLink.awork_company_id, awork_company_id),
        eq(aworkCompanyLink.customer_id, customer_id),
      ),
    );
  if (existing.length === 0) {
    return err(
      "not_found",
      `no link from awork company ${awork_company_id} to customer ${customer_id}`,
    );
  }
  await db
    .delete(aworkCompanyLink)
    .where(
      and(
        eq(aworkCompanyLink.awork_company_id, awork_company_id),
        eq(aworkCompanyLink.customer_id, customer_id),
      ),
    );
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
    const [existing] = await db
      .select({ description: setting.description })
      .from(setting)
      .where(eq(setting.key, key));
    if (existing) description = existing.description ?? null;
  }

  const now = new Date();
  await db.execute(sql`
    INSERT INTO setting (key, value, description, updated_at)
    VALUES (${key}, ${parsed.data.value}, ${description}, ${now})
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at
  `);

  const [row] = await db
    .select({
      key: setting.key,
      value: setting.value,
      description: setting.description,
      updated_at: setting.updated_at,
    })
    .from(setting)
    .where(eq(setting.key, key));
  if (!row) return err("internal_error", "setting upsert vanished");
  return ok({
    key: row.key,
    value: row.value,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
  });
}
