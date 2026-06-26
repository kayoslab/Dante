import { and, eq, ilike, inArray, sql } from "drizzle-orm";

import { escapeLikePattern } from "../../agent/_validation";
import { db } from "../client";
import {
  appUser,
  assignment,
  aworkProject,
  aworkProjectLink,
  customer,
  frameworkAgreement,
  personioProject,
  personioProjectLink,
  project,
  projectRate,
  projectSdm,
} from "../schema";

export type Rate = {
  profile: string;
  valid_from: string;
  daily_rate_eur: string | null;
};

export type ProjectAssignment = {
  assignment_id: number;
  kind: string;
  who_name: string | null;
  employee_id: number | null;
  freelancer_id: number | null;
  profile: string | null;
  allocation_pct: string | null;
  start_date: string | null;
  end_date: string | null;
  daily_rate_override_eur: string | null;
  daily_cost_override_eur: string | null;
  effective_profile: string | null;
  effective_daily_rate_eur: string | null;
  rate_source: string | null;
  notes: string | null;
};

export type ProjectEconomics = {
  n_current_employees: number;
  n_current_freelancers: number;
  total_allocation_now: string | null;
  monthly_revenue_now: string | null;
  monthly_internal_cost_now: string | null;
  monthly_external_cost_now: string | null;
  monthly_cost_now: string | null;
  monthly_gross_margin_now: string | null;
  monthly_gross_margin_pct: string | null;
};

export type ProjectDetail = {
  project_id: number;
  customer_id: number;
  customer_name: string;
  framework_id: number | null;
  framework_name: string | null;
  name: string;
  billing_model: string;
  agreed_amount_eur: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  rates: Rate[];
  framework_rates: Rate[];
  assignments: ProjectAssignment[];
  economics: ProjectEconomics;
};

export async function getProjectDetail(
  project_id: number,
): Promise<ProjectDetail | null> {
  const detailRes = await db.execute(sql`
    SELECT p.project_id, p.customer_id, c.name AS customer_name,
           p.framework_id,
           (SELECT name FROM framework_agreement WHERE framework_id = p.framework_id) AS framework_name,
           p.name, p.billing_model, p.agreed_amount_eur,
           p.planned_start_date, p.planned_end_date, p.status, p.notes,
           p.created_at
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.project_id = ${project_id}
  `);
  const row = (detailRes.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const ratesRes = await db.execute(sql`
    SELECT profile, valid_from, daily_rate_eur FROM project_rate
    WHERE project_id = ${project_id}
    ORDER BY profile, valid_from
  `);
  const rates = (ratesRes.rows as Array<Record<string, unknown>>).map((r) => ({
    profile: r.profile as string,
    valid_from: r.valid_from as string,
    daily_rate_eur:
      r.daily_rate_eur === null || r.daily_rate_eur === undefined
        ? null
        : String(r.daily_rate_eur),
  }));

  let framework_rates: Rate[] = [];
  if (row.framework_id !== null && row.framework_id !== undefined) {
    const frRes = await db.execute(sql`
      SELECT profile, valid_from, daily_rate_eur FROM framework_rate
      WHERE framework_id = ${row.framework_id as number}
      ORDER BY profile, valid_from
    `);
    framework_rates = (frRes.rows as Array<Record<string, unknown>>).map((r) => ({
      profile: r.profile as string,
      valid_from: r.valid_from as string,
      daily_rate_eur:
        r.daily_rate_eur === null || r.daily_rate_eur === undefined
          ? null
          : String(r.daily_rate_eur),
    }));
  }

  const asnRes = await db.execute(sql`
    SELECT a.assignment_id,
           CASE WHEN a.employee_id IS NOT NULL THEN 'employee' ELSE 'freelancer' END AS kind,
           COALESCE(ec.first_name || ' ' || ec.last_name, f.name) AS who_name,
           a.employee_id, a.freelancer_id,
           a.profile, a.allocation_pct,
           a.start_date, a.end_date,
           a.daily_rate_override_eur, a.daily_cost_override_eur,
           aer.effective_profile, aer.effective_daily_rate_eur, aer.rate_source,
           a.notes
    FROM assignment a
    LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
    LEFT JOIN freelancer f ON f.freelancer_id = a.freelancer_id
    LEFT JOIN assignment_effective_rate aer ON aer.assignment_id = a.assignment_id
    WHERE a.project_id = ${project_id}
    ORDER BY (a.end_date IS NULL) DESC, a.start_date DESC
  `);
  const assignments = (asnRes.rows as Array<Record<string, unknown>>).map((r) => ({
    assignment_id: r.assignment_id as number,
    kind: r.kind as string,
    who_name: r.who_name as string | null,
    employee_id: (r.employee_id as number | null) ?? null,
    freelancer_id: (r.freelancer_id as number | null) ?? null,
    profile: r.profile as string | null,
    allocation_pct:
      r.allocation_pct === null || r.allocation_pct === undefined
        ? null
        : String(r.allocation_pct),
    start_date: r.start_date as string | null,
    end_date: r.end_date as string | null,
    daily_rate_override_eur:
      r.daily_rate_override_eur === null || r.daily_rate_override_eur === undefined
        ? null
        : String(r.daily_rate_override_eur),
    daily_cost_override_eur:
      r.daily_cost_override_eur === null || r.daily_cost_override_eur === undefined
        ? null
        : String(r.daily_cost_override_eur),
    effective_profile: r.effective_profile as string | null,
    effective_daily_rate_eur:
      r.effective_daily_rate_eur === null || r.effective_daily_rate_eur === undefined
        ? null
        : String(r.effective_daily_rate_eur),
    rate_source: r.rate_source as string | null,
    notes: r.notes as string | null,
  }));

  const econRes = await db.execute(sql`
    SELECT n_current_employees, n_current_freelancers, total_allocation_now,
           monthly_revenue_now, monthly_internal_cost_now, monthly_external_cost_now,
           monthly_cost_now, monthly_gross_margin_now
    FROM project_summary WHERE project_id = ${project_id}
  `);
  const e = (econRes.rows as Array<Record<string, unknown>>)[0];
  const sNum = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  let economics: ProjectEconomics;
  if (!e) {
    economics = {
      n_current_employees: 0,
      n_current_freelancers: 0,
      total_allocation_now: null,
      monthly_revenue_now: null,
      monthly_internal_cost_now: null,
      monthly_external_cost_now: null,
      monthly_cost_now: null,
      monthly_gross_margin_now: null,
      monthly_gross_margin_pct: null,
    };
  } else {
    const rev = e.monthly_revenue_now;
    const margin = e.monthly_gross_margin_now;
    let margin_pct: string | null = null;
    if (
      rev !== null &&
      rev !== undefined &&
      margin !== null &&
      margin !== undefined
    ) {
      const revF = Number(rev);
      if (revF > 0) {
        margin_pct = ((Number(margin) / revF) * 100).toFixed(2);
      }
    }
    economics = {
      n_current_employees: Number(e.n_current_employees ?? 0),
      n_current_freelancers: Number(e.n_current_freelancers ?? 0),
      total_allocation_now: sNum(e.total_allocation_now),
      monthly_revenue_now: sNum(e.monthly_revenue_now),
      monthly_internal_cost_now: sNum(e.monthly_internal_cost_now),
      monthly_external_cost_now: sNum(e.monthly_external_cost_now),
      monthly_cost_now: sNum(e.monthly_cost_now),
      monthly_gross_margin_now: sNum(e.monthly_gross_margin_now),
      monthly_gross_margin_pct: margin_pct,
    };
  }

  return {
    project_id: row.project_id as number,
    customer_id: row.customer_id as number,
    customer_name: row.customer_name as string,
    framework_id: (row.framework_id as number | null) ?? null,
    framework_name: (row.framework_name as string | null) ?? null,
    name: row.name as string,
    billing_model: row.billing_model as string,
    agreed_amount_eur:
      row.agreed_amount_eur === null || row.agreed_amount_eur === undefined
        ? null
        : String(row.agreed_amount_eur),
    planned_start_date: row.planned_start_date as string | null,
    planned_end_date: row.planned_end_date as string | null,
    status: row.status as string,
    notes: row.notes as string | null,
    created_at: new Date(row.created_at as Date | string).toISOString(),
    rates,
    framework_rates,
    assignments,
    economics,
  };
}

export type ProjectListRow = {
  project_id: unknown;
  name: unknown;
  customer_id: unknown;
  customer_name: unknown;
  billing_model: unknown;
  status: unknown;
  framework_id: unknown;
  framework_name: unknown;
  planned_start_date: unknown;
  planned_end_date: unknown;
};

export async function listProjects(filters: {
  status: string | null;
  customer_id: number | null;
}): Promise<ProjectListRow[]> {
  const conds: ReturnType<typeof sql>[] = [];
  if (filters.status) conds.push(sql`p.status = ${filters.status}`);
  if (filters.customer_id !== null && Number.isInteger(filters.customer_id)) {
    conds.push(sql`p.customer_id = ${filters.customer_id}`);
  }
  const where =
    conds.length === 0 ? sql`1=1` : sql.join(conds, sql` AND `);

  const result = await db.execute(sql`
    SELECT p.project_id, p.name, p.customer_id, c.name AS customer_name,
           p.billing_model, p.status, p.framework_id,
           (SELECT name FROM framework_agreement WHERE framework_id = p.framework_id) AS framework_name,
           p.planned_start_date, p.planned_end_date
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE ${where}
    ORDER BY c.name, p.name
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    project_id: r.project_id,
    name: r.name,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    billing_model: r.billing_model,
    status: r.status,
    framework_id: r.framework_id,
    framework_name: r.framework_name,
    planned_start_date: r.planned_start_date,
    planned_end_date: r.planned_end_date,
  }));
}

/** Lightweight header (name + billing model + agreed amount). Used by
 * the monthly-series route, which iterates per-month via
 * `computeProjectMonthly` and needs the project shell for the response
 * envelope. Returns `null` when the project does not exist so the
 * caller owns the `NotFound` envelope. */
export type ProjectHeaderRow = {
  name: string;
  billing_model: string;
  agreed_amount_eur: string | null;
};

export async function getProjectHeader(
  project_id: number,
): Promise<ProjectHeaderRow | null> {
  const r = await db.execute(sql`
    SELECT name, billing_model, agreed_amount_eur
    FROM project WHERE project_id = ${project_id}
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    name: row.name as string,
    billing_model: row.billing_model as string,
    agreed_amount_eur: row.agreed_amount_eur as string | null,
  };
}

export type ProjectAworkLinkRow = {
  awork_project_id: unknown;
  name: unknown;
  project_key: unknown;
  awork_company_id: unknown;
  awork_company_name: string | null;
  mapped_to_project_id: number;
  mapped_to_project_name: null;
  mapped_to_customer_name: null;
  is_billable_by_default: null;
  is_external: null;
  n_time_entries: number;
};

export async function listProjectAworkLinks(
  project_id: number,
): Promise<ProjectAworkLinkRow[]> {
  const r = await db.execute(sql`
    SELECT ap.awork_project_id, ap.name, ap.project_key,
           ap.awork_company_id, co.name AS awork_company_name,
           COALESCE(t.n_entries, 0)::int AS n_entries
    FROM awork_project_link link
    JOIN awork_project ap ON ap.awork_project_id = link.awork_project_id
    LEFT JOIN awork_company co ON co.awork_company_id = ap.awork_company_id
    LEFT JOIN (
      SELECT awork_project_id, COUNT(*) AS n_entries
      FROM awork_time_entry
      WHERE awork_project_id IS NOT NULL
      GROUP BY awork_project_id
    ) t ON t.awork_project_id = link.awork_project_id
    WHERE link.project_id = ${project_id}
    ORDER BY ap.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    awork_project_id: row.awork_project_id,
    name: row.name,
    project_key: row.project_key,
    awork_company_id: row.awork_company_id,
    awork_company_name: (row.awork_company_name as string | null) ?? null,
    mapped_to_project_id: project_id,
    mapped_to_project_name: null,
    mapped_to_customer_name: null,
    is_billable_by_default: null,
    is_external: null,
    n_time_entries: Number(row.n_entries ?? 0),
  }));
}

export type ProjectPersonioLinkRow = {
  personio_project_id: unknown;
  name: unknown;
  active: unknown;
  n_attendance_entries: number;
  mapped_to_project_id: number;
  mapped_to_project_name: null;
  mapped_to_customer_name: null;
};

export async function listProjectPersonioLinks(
  project_id: number,
): Promise<ProjectPersonioLinkRow[]> {
  const r = await db.execute(sql`
    SELECT pp.personio_project_id, pp.name, pp.active,
           COALESCE(att.n_entries, 0)::int AS n_entries, link.mapped_at
    FROM personio_project_link link
    JOIN personio_project pp
      ON pp.personio_project_id = link.personio_project_id
    LEFT JOIN (
      SELECT project_id AS personio_project_id, COUNT(*) AS n_entries
      FROM attendance WHERE project_id IS NOT NULL
      GROUP BY project_id
    ) att ON att.personio_project_id = link.personio_project_id
    WHERE link.project_id = ${project_id}
    ORDER BY pp.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    personio_project_id: row.personio_project_id,
    name: row.name,
    active: row.active,
    n_attendance_entries: Number(row.n_entries ?? 0),
    mapped_to_project_id: project_id,
    mapped_to_project_name: null,
    mapped_to_customer_name: null,
  }));
}

export type ProjectLoggedTimeConsultant = {
  employee_id: unknown;
  who_name: unknown;
  total_hours: number;
  total_days: string;
  first_log_date: unknown;
  last_log_date: unknown;
  sources: string[];
  n_assignments: number;
};

export type ProjectLoggedTimeSummary = {
  project_id: number;
  project_name: string;
  n_consultants: number;
  total_hours: number;
  total_days: string;
  consultants: ProjectLoggedTimeConsultant[];
} | null;

export async function getProjectLoggedTimeSummary(
  project_id: number,
): Promise<ProjectLoggedTimeSummary> {
  const proj = await db.execute(sql`
    SELECT name FROM project WHERE project_id = ${project_id}
  `);
  const pRow = (proj.rows as Array<{ name: string }>)[0];
  if (!pRow) return null;
  const project_name = pRow.name;

  // Dedup per (employee, day) between Personio and awork so a project
  // mapped in both doesn't double-count tracked hours.
  const result = await db.execute(sql`
    WITH personio AS (
      SELECT a.employee_id, a.work_date,
             SUM(a.duration_minutes) AS minutes
      FROM attendance a
      JOIN personio_project_link pl
        ON pl.personio_project_id = a.project_id
      WHERE pl.project_id = ${project_id}
      GROUP BY a.employee_id, a.work_date
    ),
    awork AS (
      SELECT ul.employee_id, t.work_date,
             SUM(t.duration_minutes) AS minutes
      FROM awork_time_entry t
      JOIN awork_project_link apl
        ON apl.awork_project_id = t.awork_project_id
      JOIN awork_user_link ul
        ON ul.awork_user_id = t.awork_user_id
      WHERE apl.project_id = ${project_id}
      GROUP BY ul.employee_id, t.work_date
    ),
    deduped AS (
      SELECT employee_id, work_date, MAX(minutes) AS minutes
      FROM (SELECT * FROM personio UNION ALL SELECT * FROM awork) u
      GROUP BY employee_id, work_date
    ),
    consolidated AS (
      SELECT
        d.employee_id,
        SUM(d.minutes) AS total_min,
        MIN(d.work_date) AS earliest,
        MAX(d.work_date) AS latest,
        MAX(CASE WHEN EXISTS (SELECT 1 FROM personio p WHERE p.employee_id = d.employee_id AND p.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_personio,
        MAX(CASE WHEN EXISTS (SELECT 1 FROM awork w WHERE w.employee_id = d.employee_id AND w.work_date = d.work_date) THEN 1 ELSE 0 END) AS has_awork
      FROM deduped d
      GROUP BY d.employee_id
    )
    SELECT
      c.employee_id,
      ec.first_name || ' ' || ec.last_name AS who_name,
      c.total_min, c.earliest, c.latest,
      c.has_personio, c.has_awork,
      (SELECT COUNT(*) FROM assignment a
       WHERE a.employee_id = c.employee_id AND a.project_id = ${project_id}) AS n_assignments
    FROM consolidated c
    LEFT JOIN employee_current ec ON ec.employee_id = c.employee_id
    WHERE c.total_min > 0
    ORDER BY c.total_min DESC
  `);

  let total_hours = 0;
  const consultants: ProjectLoggedTimeConsultant[] = [];
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const total_min = Number(raw.total_min ?? 0);
    const hours = Math.round(total_min / 60);
    if (hours === 0) continue;
    const days = Math.round((hours / 8) * 1000) / 1000;
    const sources: string[] = [];
    if (Number(raw.has_personio) === 1) sources.push("personio");
    if (Number(raw.has_awork) === 1) sources.push("awork");
    consultants.push({
      employee_id: raw.employee_id,
      who_name: raw.who_name,
      total_hours: hours,
      total_days: days.toFixed(3),
      first_log_date: raw.earliest,
      last_log_date: raw.latest,
      sources,
      n_assignments: Number(raw.n_assignments ?? 0),
    });
    total_hours += hours;
  }

  return {
    project_id,
    project_name,
    n_consultants: consultants.length,
    total_hours,
    total_days: (total_hours / 8).toFixed(3),
    consultants,
  };
}

// ----------------------------------------------------------------------------
// Write-side helpers used by Server Actions.
// ----------------------------------------------------------------------------

/** Return the framework's `customer_id` (the field of interest when
 * validating that a framework belongs to the project's customer). `null`
 * when the framework does not exist. */
export async function getFrameworkCustomerId(
  framework_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ customer_id: frameworkAgreement.customer_id })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  return row?.customer_id ?? null;
}

/** Is there already a project with this name on this customer? */
/** Fuzzy ILIKE-substring lookup for the agent's `matchProjects`
 * endpoint. When `customer_id` is non-null, scopes to that customer.
 * Ordered by name length so shorter matches surface first. */
export async function matchProjectsByName(
  q: string,
  limit: number,
  customer_id: number | null,
): Promise<
  Array<{
    project_id: number;
    name: string;
    customer_id: number;
    customer_name: string;
    billing_model: string;
    status: string;
  }>
> {
  // Escape `%` / `_` / `\` so a caller can't turn a fuzzy lookup into
  // an unrestricted scan with q="%".
  const pattern = `%${escapeLikePattern(q)}%`;
  const where =
    customer_id !== null
      ? and(ilike(project.name, pattern), eq(project.customer_id, customer_id))
      : ilike(project.name, pattern);
  return db
    .select({
      project_id: project.project_id,
      name: project.name,
      customer_id: project.customer_id,
      customer_name: customer.name,
      billing_model: project.billing_model,
      status: project.status,
    })
    .from(project)
    .innerJoin(customer, eq(customer.customer_id, project.customer_id))
    .where(where)
    .orderBy(sql`length(${project.name})`)
    .limit(limit);
}

export async function findProjectByCustomerAndName(
  customer_id: number,
  name: string,
): Promise<number | null> {
  const [row] = await db
    .select({ id: project.project_id })
    .from(project)
    .where(and(eq(project.customer_id, customer_id), eq(project.name, name)));
  return row?.id ?? null;
}

/** Project row's customer_id — used by updateProjectAction to verify
 * that a candidate framework belongs to the same customer. */
export async function getProjectCustomerId(
  project_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ customer_id: project.customer_id })
    .from(project)
    .where(eq(project.project_id, project_id));
  return row?.customer_id ?? null;
}

/** Just the project name (used by deleteProjectAction's error message). */
export async function getProjectName(
  project_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ name: project.name })
    .from(project)
    .where(eq(project.project_id, project_id));
  return row?.name ?? null;
}

/** Lightweight existence probe. */
export async function projectExists(project_id: number): Promise<boolean> {
  const rows = await db
    .select({ id: project.project_id })
    .from(project)
    .where(eq(project.project_id, project_id));
  return rows.length > 0;
}

export type CreateProjectInput = {
  customer_id: number;
  framework_id: number | null;
  name: string;
  billing_model: string;
  agreed_amount_eur: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  status: string;
  notes: string | null;
};

/** Insert a project. Returns the new `project_id`. Lets uniqueness
 * violations bubble up so the caller can translate them to a conflict
 * envelope. */
export async function insertProject(
  input: CreateProjectInput,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .insert(project)
    .values({
      customer_id: input.customer_id,
      framework_id: input.framework_id,
      name: input.name,
      billing_model: input.billing_model,
      agreed_amount_eur: input.agreed_amount_eur,
      planned_start_date: input.planned_start_date,
      planned_end_date: input.planned_end_date,
      status: input.status,
      notes: input.notes,
      created_at: now,
      updated_at: now,
    })
    .returning({ project_id: project.project_id });
  return rows[0].project_id;
}

/** Apply a partial update to a project row. The caller is responsible
 * for filtering the keys it wants to mutate; we always stamp
 * `updated_at`. Unique-violation errors bubble up. */
export async function updateProject(
  project_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(project)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(project.project_id, project_id));
}

/** Set just `time_budget_hours` on an existing project. Used by the
 * awork import path which patches in the awork-project's time budget
 * after the project row has already been created by
 * `createProjectAction` (which doesn't know about `time_budget_hours`
 * — it's a Phase B.4 addition). Deliberately does NOT stamp
 * `updated_at`: the prior inline UPDATE in the action didn't either,
 * and the import is part of a single logical write. */
export async function setProjectTimeBudgetHours(
  project_id: number,
  time_budget_hours: number,
): Promise<void> {
  await db
    .update(project)
    .set({ time_budget_hours })
    .where(eq(project.project_id, project_id));
}

/** Default `valid_from` for a new rate: use the project's planned
 * start date if set, else today. Kept here so the Server Action stays
 * free of DB reads. */
export async function getProjectRateDefaultValidFrom(
  project_id: number,
): Promise<string> {
  const [row] = await db
    .select({ planned_start_date: project.planned_start_date })
    .from(project)
    .where(eq(project.project_id, project_id));
  if (row?.planned_start_date) return row.planned_start_date;
  return new Date().toISOString().slice(0, 10);
}

/** Number of rate rows attached to a project — used by the cascade
 * gate in `deleteProjectAction`. */
export async function listProjectRateKeys(
  project_id: number,
): Promise<Array<{ profile: string; valid_from: string }>> {
  return db
    .select({
      profile: projectRate.profile,
      valid_from: projectRate.valid_from,
    })
    .from(projectRate)
    .where(eq(projectRate.project_id, project_id));
}

/** Assignment IDs on a project (cascade gate). */
export async function listProjectAssignmentIds(
  project_id: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: assignment.assignment_id })
    .from(assignment)
    .where(eq(assignment.project_id, project_id));
  return rows.map((r) => r.id);
}

/** Cascade-delete a project's children (assignments + rates) if any.
 * Used by `deleteProjectAction` when the operator passes `force=true`. */
export async function deleteProjectChildren(project_id: number): Promise<void> {
  await db.delete(assignment).where(eq(assignment.project_id, project_id));
  await db
    .delete(projectRate)
    .where(eq(projectRate.project_id, project_id));
}

export async function deleteProjectAssignments(
  project_id: number,
): Promise<void> {
  await db.delete(assignment).where(eq(assignment.project_id, project_id));
}

export async function deleteProjectRates(project_id: number): Promise<void> {
  await db.delete(projectRate).where(eq(projectRate.project_id, project_id));
}

/** Delete the project row itself. */
export async function deleteProject(project_id: number): Promise<void> {
  await db.delete(project).where(eq(project.project_id, project_id));
}

/** Look up an existing rate row (by PK). Returns the current
 * `daily_rate_eur` so the action can both confirm existence and
 * surface the value in its conflict message. */
export async function getProjectRate(
  project_id: number,
  profile: string,
  valid_from: string,
): Promise<string | null> {
  const [row] = await db
    .select({ daily_rate_eur: projectRate.daily_rate_eur })
    .from(projectRate)
    .where(
      and(
        eq(projectRate.project_id, project_id),
        eq(projectRate.profile, profile),
        eq(projectRate.valid_from, valid_from),
      ),
    );
  return row?.daily_rate_eur ?? null;
}

export async function insertProjectRate(input: {
  project_id: number;
  profile: string;
  valid_from: string;
  daily_rate_eur: string;
}): Promise<void> {
  await db.insert(projectRate).values(input);
}

export async function updateProjectRate(
  project_id: number,
  profile: string,
  valid_from: string,
  daily_rate_eur: string,
): Promise<void> {
  await db
    .update(projectRate)
    .set({ daily_rate_eur })
    .where(
      and(
        eq(projectRate.project_id, project_id),
        eq(projectRate.profile, profile),
        eq(projectRate.valid_from, valid_from),
      ),
    );
}

export async function deleteProjectRate(
  project_id: number,
  profile: string,
  valid_from: string,
): Promise<void> {
  await db
    .delete(projectRate)
    .where(
      and(
        eq(projectRate.project_id, project_id),
        eq(projectRate.profile, profile),
        eq(projectRate.valid_from, valid_from),
      ),
    );
}

// ----------------------------------------------------------------------------
// Project merge — single transaction.
// ----------------------------------------------------------------------------

export type MergeProjectsResult = {
  target_project_id: number;
  moved_assignments: number;
  moved_rates: number;
  dropped_rates: number;
  moved_personio_links: number;
  moved_awork_links: number;
};

export type MergeProjectsPreflight =
  | { ok: true }
  | { ok: false; reason: "not_found" };

/** Confirm both project rows exist before opening the transaction.
 * Kept outside the transaction because Drizzle's tx callback typing
 * fights early-returns. */
export async function preflightMergeProjects(
  source_project_id: number,
  target_project_id: number,
): Promise<MergeProjectsPreflight> {
  const both = await db
    .select({ id: project.project_id })
    .from(project)
    .where(inArray(project.project_id, [source_project_id, target_project_id]));
  if (both.length !== 2) return { ok: false, reason: "not_found" };
  return { ok: true };
}

/** Move every reference off source onto target and drop the source
 * row. Single transaction. Rate-row conflicts on `(project_id, profile,
 * valid_from)` are resolved target-wins: the conflicting source rows
 * are dropped before the rest are reassigned. */
export async function mergeProjects(
  source_project_id: number,
  target_project_id: number,
): Promise<MergeProjectsResult> {
  return db.transaction(async (tx) => {
    // Drop conflicting rate rows on the source — source loses, target keeps.
    const conflicting = await tx
      .select({
        profile: projectRate.profile,
        valid_from: projectRate.valid_from,
      })
      .from(projectRate)
      .where(eq(projectRate.project_id, source_project_id));
    let dropped_rates = 0;
    if (conflicting.length > 0) {
      const targetRates = await tx
        .select({
          profile: projectRate.profile,
          valid_from: projectRate.valid_from,
        })
        .from(projectRate)
        .where(eq(projectRate.project_id, target_project_id));
      const targetKeys = new Set(
        targetRates.map((r) => `${r.profile}|${r.valid_from}`),
      );
      const dropKeys = conflicting
        .filter((r) => targetKeys.has(`${r.profile}|${r.valid_from}`))
        .map((r) => `${r.profile}|${r.valid_from}`);
      for (const key of dropKeys) {
        const [profile, valid_from] = key.split("|");
        await tx
          .delete(projectRate)
          .where(
            and(
              eq(projectRate.project_id, source_project_id),
              eq(projectRate.profile, profile),
              eq(projectRate.valid_from, valid_from),
            ),
          );
        dropped_rates += 1;
      }
    }

    // Move the rest of the rates.
    const movedRates = await tx
      .update(projectRate)
      .set({ project_id: target_project_id })
      .where(eq(projectRate.project_id, source_project_id))
      .returning({ profile: projectRate.profile });

    // Move assignments (no UNIQUE on project_id, no conflict possible).
    const movedAssignments = await tx
      .update(assignment)
      .set({ project_id: target_project_id })
      .where(eq(assignment.project_id, source_project_id))
      .returning({ id: assignment.assignment_id });

    // Move Personio + awork link rows (PK is the upstream id, not project_id).
    const movedPersonio = await tx
      .update(personioProjectLink)
      .set({ project_id: target_project_id })
      .where(eq(personioProjectLink.project_id, source_project_id))
      .returning({ id: personioProjectLink.personio_project_id });

    const movedAwork = await tx
      .update(aworkProjectLink)
      .set({ project_id: target_project_id })
      .where(eq(aworkProjectLink.project_id, source_project_id))
      .returning({ id: aworkProjectLink.awork_project_id });

    // Drop the now-orphaned source project.
    await tx.delete(project).where(eq(project.project_id, source_project_id));

    return {
      target_project_id,
      moved_assignments: movedAssignments.length,
      moved_rates: movedRates.length,
      dropped_rates,
      moved_personio_links: movedPersonio.length,
      moved_awork_links: movedAwork.length,
    } satisfies MergeProjectsResult;
  });
}

// ----------------------------------------------------------------------------
// Project SDM grants.
// ----------------------------------------------------------------------------

export async function getAppUserRole(
  user_id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: appUser.user_id, role: appUser.role })
    .from(appUser)
    .where(eq(appUser.user_id, user_id));
  return row?.role ?? null;
}

export async function insertProjectSdm(input: {
  project_id: number;
  user_id: string;
  granted_by: string;
}): Promise<void> {
  await db
    .insert(projectSdm)
    .values(input)
    .onConflictDoNothing();
}

export async function deleteProjectSdm(
  project_id: number,
  user_id: string,
): Promise<void> {
  await db
    .delete(projectSdm)
    .where(
      and(
        eq(projectSdm.project_id, project_id),
        eq(projectSdm.user_id, user_id),
      ),
    );
}

// ----------------------------------------------------------------------------
// personio_project_link write-side helpers.
// ----------------------------------------------------------------------------

/** Look up a personio project's name — used in error messages when
 * the FE tries to link an unknown personio project. `null` when the
 * upstream row does not exist (operator needs to run `dante sync`). */
export async function getPersonioProjectName(
  personio_project_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ name: personioProject.name })
    .from(personioProject)
    .where(eq(personioProject.personio_project_id, personio_project_id));
  return row?.name ?? null;
}

/** Is this personio project already linked? Returns the linked
 * `project_id` (so the caller can craft a useful error message) or
 * `null` if no link exists. */
export async function getPersonioLinkProjectId(
  personio_project_id: number,
): Promise<number | null> {
  const [row] = await db
    .select({ project_id: personioProjectLink.project_id })
    .from(personioProjectLink)
    .where(
      eq(personioProjectLink.personio_project_id, personio_project_id),
    );
  return row?.project_id ?? null;
}

export async function insertPersonioProjectLink(input: {
  personio_project_id: number;
  project_id: number;
}): Promise<void> {
  await db.insert(personioProjectLink).values({
    personio_project_id: input.personio_project_id,
    project_id: input.project_id,
    mapped_at: new Date(),
  });
}

export async function deletePersonioProjectLink(
  project_id: number,
  personio_project_id: number,
): Promise<number> {
  const rows = await db
    .delete(personioProjectLink)
    .where(
      and(
        eq(personioProjectLink.personio_project_id, personio_project_id),
        eq(personioProjectLink.project_id, project_id),
      ),
    )
    .returning({ id: personioProjectLink.personio_project_id });
  return rows.length;
}

// ----------------------------------------------------------------------------
// awork_project_link write-side helpers.
// ----------------------------------------------------------------------------

/** Look up an awork project's name — `null` when the upstream awork
 * project row does not exist. */
export async function getAworkProjectName(
  awork_project_id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: aworkProject.name })
    .from(aworkProject)
    .where(eq(aworkProject.awork_project_id, awork_project_id));
  return row?.name ?? null;
}

/** Is this awork project already linked? Returns the linked
 * `project_id` or `null`. */
export async function getAworkProjectLinkProjectId(
  awork_project_id: string,
): Promise<number | null> {
  const [row] = await db
    .select({ project_id: aworkProjectLink.project_id })
    .from(aworkProjectLink)
    .where(eq(aworkProjectLink.awork_project_id, awork_project_id));
  return row?.project_id ?? null;
}

export async function insertAworkProjectLink(input: {
  awork_project_id: string;
  project_id: number;
}): Promise<void> {
  await db.insert(aworkProjectLink).values({
    awork_project_id: input.awork_project_id,
    project_id: input.project_id,
    mapped_at: new Date(),
  });
}

export async function deleteAworkProjectLink(
  project_id: number,
  awork_project_id: string,
): Promise<number> {
  const rows = await db
    .delete(aworkProjectLink)
    .where(
      and(
        eq(aworkProjectLink.awork_project_id, awork_project_id),
        eq(aworkProjectLink.project_id, project_id),
      ),
    )
    .returning({ id: aworkProjectLink.awork_project_id });
  return rows.length;
}
