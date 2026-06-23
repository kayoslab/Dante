import { asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { roleTierFromAlias } from "../_sql-fragments";
import { employeeAnnotation, team } from "../schema";

/** Compact row returned by `getTeamItem` and friends. The action layer
 * uses this verbatim — keep the field shape stable. */
export type TeamItem = { team_name: string; n_members: number };

/** Full team listing with member counts. Used by `/api/teams` for
 * the manager-facing team picker. Ordered by name for stable UI. */
export async function listTeams(): Promise<TeamItem[]> {
  const rows = await db
    .select({
      team_name: team.team_name,
      n_members: sql<number>`COUNT(${employeeAnnotation.employee_id})::int`.as(
        "n_members",
      ),
    })
    .from(team)
    .leftJoin(
      employeeAnnotation,
      eq(employeeAnnotation.team_user, team.team_name),
    )
    .groupBy(team.team_name)
    .orderBy(asc(team.team_name));
  return rows.map((r) => ({
    team_name: r.team_name,
    n_members: Number(r.n_members),
  }));
}

/** Existence probe: does a team with this exact name exist? */
export async function teamExists(team_name: string): Promise<boolean> {
  const rows = await db
    .select({ name: team.team_name })
    .from(team)
    .where(eq(team.team_name, team_name));
  return rows.length > 0;
}

/** Fetch a single team's list row (name + member count from the
 * `employee_annotation.team_user` denormalised column). Returns null
 * when the team isn't on file. */
export async function getTeamItem(
  team_name: string,
): Promise<TeamItem | null> {
  const r = await db.execute(sql`
    SELECT t.team_name, COUNT(a.employee_id)::int AS n_members
    FROM team t
    LEFT JOIN employee_annotation a ON a.team_user = t.team_name
    WHERE t.team_name = ${team_name}
    GROUP BY t.team_name
  `);
  const row = (r.rows as Array<{ team_name: string; n_members: number }>)[0];
  if (!row) return null;
  return { team_name: row.team_name, n_members: Number(row.n_members) };
}

/** Insert a brand-new team row. Caller is responsible for the duplicate
 * pre-check; this throws on PK violation. */
export async function insertTeam(team_name: string): Promise<void> {
  const now = new Date();
  await db.insert(team).values({
    team_name,
    created_at: now,
    updated_at: now,
  });
}

/** Rename a team and cascade the new label into every assigned
 * employee's denormalised `employee_annotation.team_user` so the two
 * columns stay consistent. Both writes share a single timestamp so the
 * rename's `last_reconciled_at` lines up across rows. */
export async function renameTeamWithCascade(
  old_name: string,
  new_name: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(team)
    .set({ team_name: new_name, updated_at: now })
    .where(eq(team.team_name, old_name));
  await db
    .update(employeeAnnotation)
    .set({ team_user: new_name, last_reconciled_at: now })
    .where(eq(employeeAnnotation.team_user, old_name));
}

/** Count of employees currently assigned to a team via
 * `employee_annotation.team_user`. */
export async function countTeamMembers(team_name: string): Promise<number> {
  const rows = await db
    .select({ id: employeeAnnotation.employee_id })
    .from(employeeAnnotation)
    .where(eq(employeeAnnotation.team_user, team_name));
  return rows.length;
}

/** Clear every employee's `team_user` for a soon-to-be-deleted team.
 * Used by `deleteTeamAction` when `force=true`. Stamps
 * `last_reconciled_at` on the touched rows. */
export async function clearTeamMembers(team_name: string): Promise<void> {
  const now = new Date();
  await db
    .update(employeeAnnotation)
    .set({ team_user: null, last_reconciled_at: now })
    .where(eq(employeeAnnotation.team_user, team_name));
}

/** Delete the team row itself. Caller has already cleared members (or
 * confirmed there are none) before invoking. */
export async function deleteTeamRow(team_name: string): Promise<void> {
  await db.delete(team).where(eq(team.team_name, team_name));
}

// ---------------------------------------------------------------------------
// Team detail page — readers
//
// The detail page reuses the per-employee monthly engine
// (`computeEmployeeMonthly`) and aggregates across team members. The
// queries below resolve the slug, list the roster, and pull the
// assignment rows the page needs to project the next 90 days of
// coverage / endings. The chart's history+forecast series fetches via
// `/api/teams/[slug]/monthly-series` because iterating
// `computeEmployeeMonthly` per-member-per-month is too slow to
// server-render.
// ---------------------------------------------------------------------------

/** Resolve a URL slug back to the original team name. Returns null
 * when no team's slug matches. The team set is small enough that a
 * linear scan is faster than a SQL function call.
 *
 * Two teams that slugify identically would collide here; first match
 * wins. The action layer's `createTeam` could enforce uniqueness if
 * that becomes a real risk. */
export async function findTeamBySlug(
  slug: string,
  slugify: (name: string) => string,
): Promise<string | null> {
  const rows = await db.select({ name: team.team_name }).from(team);
  for (const r of rows) {
    if (slugify(r.name) === slug) return r.name;
  }
  return null;
}

export type TeamMember = {
  employee_id: number;
  first_name: string | null;
  last_name: string | null;
  who_name: string;
  role_tier: string | null;
  hire_date: string | null;
  employment_end_date: string | null;
};

/** Roster lookup for the detail page. Filters to active, real,
 * project-contributing employees whose contract overlaps `as_of`
 * (matches the bench query's eligibility rules so the team page's
 * totals tie to the home bench card). */
export async function getTeamMembers(
  team_name: string,
  as_of: string,
): Promise<TeamMember[]> {
  const roleTier = roleTierFromAlias("ec", "ann");
  const r = await db.execute(sql`
    SELECT
      ec.employee_id,
      ec.first_name,
      ec.last_name,
      ec.hire_date,
      ec.employment_end_date,
      ${roleTier} AS role_tier
    FROM employee_current ec
    JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE ann.team_user = ${team_name}
      AND COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${as_of}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${as_of}::date)
    ORDER BY ec.last_name, ec.first_name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => {
    const first_name = (row.first_name as string | null) ?? null;
    const last_name = (row.last_name as string | null) ?? null;
    return {
      employee_id: row.employee_id as number,
      first_name,
      last_name,
      who_name: `${first_name ?? ""} ${last_name ?? ""}`.trim(),
      role_tier: (row.role_tier as string | null) ?? null,
      hire_date: (row.hire_date as string | null) ?? null,
      employment_end_date: (row.employment_end_date as string | null) ?? null,
    };
  });
}

export type TeamUpcomingAssignment = {
  assignment_id: number;
  employee_id: number;
  who_name: string;
  project_id: number;
  project_name: string;
  customer_name: string;
  profile: string | null;
  allocation_pct: string; // numeric as string
  start_date: string | null;
  end_date: string | null;
};

/** Every active or future assignment for the team's members within a
 * window. Used by the forecast section to identify "ending soon" and
 * "going partial" rows. Includes assignments that overlap the window
 * at either end. */
/** Team member ids in scope for the monthly-series aggregator. The
 * series endpoint iterates `computeEmployeeMonthly` for each id × each
 * month in the window, then sums the per-employee shapes server-side.
 * Same eligibility filters as `getTeamMembers` so the chart and the
 * roster sum to identical current-month totals. */
export async function getTeamMemberIds(
  team_name: string,
  from_month_start: string,
  to_month_end: string,
): Promise<number[]> {
  const r = await db.execute(sql`
    SELECT ec.employee_id
    FROM employee_current ec
    JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    WHERE ann.team_user = ${team_name}
      AND COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
      AND (ec.hire_date IS NULL OR ec.hire_date <= ${to_month_end}::date)
      AND (ec.employment_end_date IS NULL OR ec.employment_end_date >= ${from_month_start}::date)
  `);
  return (r.rows as Array<{ employee_id: number }>).map((row) =>
    Number(row.employee_id),
  );
}

export async function getTeamUpcomingAssignments(
  team_name: string,
  from: string,
  to: string,
): Promise<TeamUpcomingAssignment[]> {
  const r = await db.execute(sql`
    SELECT
      a.assignment_id, a.employee_id,
      ec.first_name, ec.last_name,
      a.project_id, p.name AS project_name, c.name AS customer_name,
      a.profile, a.allocation_pct,
      a.start_date, a.end_date
    FROM assignment a
    JOIN employee_current ec ON ec.employee_id = a.employee_id
    JOIN employee_annotation ann ON ann.employee_id = ec.employee_id
    JOIN project p ON p.project_id = a.project_id
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE ann.team_user = ${team_name}
      AND COALESCE(ann.is_real_employee, TRUE) = TRUE
      AND COALESCE(ann.is_project_contributing, TRUE) = TRUE
      AND ec.status = 'active'
      AND (a.end_date IS NULL OR a.end_date >= ${from}::date)
      AND (a.start_date IS NULL OR a.start_date <= ${to}::date)
    ORDER BY a.end_date NULLS LAST, ec.last_name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => {
    const first_name = (row.first_name as string | null) ?? null;
    const last_name = (row.last_name as string | null) ?? null;
    return {
      assignment_id: row.assignment_id as number,
      employee_id: row.employee_id as number,
      who_name: `${first_name ?? ""} ${last_name ?? ""}`.trim(),
      project_id: row.project_id as number,
      project_name: row.project_name as string,
      customer_name: row.customer_name as string,
      profile: (row.profile as string | null) ?? null,
      allocation_pct: String(row.allocation_pct),
      start_date: (row.start_date as string | null) ?? null,
      end_date: (row.end_date as string | null) ?? null,
    };
  });
}
