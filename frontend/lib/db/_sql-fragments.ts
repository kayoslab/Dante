import { sql } from "drizzle-orm";

export const roleTierFromAlias = (
  ecAlias: string,
  annAlias: string,
) => sql.raw(`
  COALESCE(
    ${annAlias}.role_tier,
    CASE
      WHEN LOWER(${ecAlias}.position) LIKE '%junior%'
        OR LOWER(${ecAlias}.position) LIKE '%jr.%'
        OR LOWER(${ecAlias}.position) LIKE '%werkstudent%'
        OR LOWER(${ecAlias}.position) LIKE '%praktikant%'
        OR LOWER(${ecAlias}.position) LIKE '%trainee%' THEN 'junior'
      WHEN LOWER(${ecAlias}.position) LIKE '%senior%'
        OR LOWER(${ecAlias}.position) LIKE 'sr. %'
        OR LOWER(${ecAlias}.position) LIKE 'sr.%' THEN 'senior'
      WHEN LOWER(${ecAlias}.position) LIKE '%head of%'
        OR LOWER(${ecAlias}.position) LIKE '%director%'
        OR LOWER(${ecAlias}.position) LIKE '%principal%'
        OR LOWER(${ecAlias}.position) LIKE '%chief%'
        OR LOWER(${ecAlias}.position) LIKE '%team lead%'
        OR LOWER(${ecAlias}.position) LIKE '%teamlead%'
        OR LOWER(${ecAlias}.position) LIKE '%expert%' THEN 'expert'
      WHEN LOWER(${ecAlias}.position) LIKE '%advanced%'
        OR LOWER(${ecAlias}.position) LIKE '%adv. %' THEN 'advanced'
      ELSE 'advanced'
    END
  )
`);

/** Effective end-date: earlier of contract_end_date or employment_end_date.
 * Returns NULL when both are NULL. Used in the employee list to display
 * the actual leaving date the user cares about.
 *
 * Expects `employee_current` aliased as the given alias. */
export const effectiveEndDateFromAlias = (ecAlias: string) => sql.raw(`
  LEAST(
    COALESCE(${ecAlias}.contract_end_date, DATE '9999-12-31'),
    COALESCE(${ecAlias}.employment_end_date, DATE '9999-12-31')
  )
`);

/** Mirrors `assignment_effective_rate` view's rate-resolution: per-assignment
 * override → project_rate → framework_rate, picking the most recent
 * `valid_from <= start_date`. Returns NULL when none match.
 *
 * Pass the assignment, project, and (effective) profile expressions. The
 * effective profile is `assignment.profile` if set, otherwise the employee's
 * role_tier — caller must compute it. */
export const effectiveRateSql = (
  asnAlias: string,
  projAlias: string,
  profileExpr: string,
) => sql.raw(`
  COALESCE(
    ${asnAlias}.daily_rate_override_eur,
    (SELECT daily_rate_eur FROM project_rate pr
     WHERE pr.project_id = ${asnAlias}.project_id
       AND pr.profile = ${profileExpr}
       AND pr.valid_from <= ${asnAlias}.start_date
     ORDER BY pr.valid_from DESC LIMIT 1),
    (SELECT daily_rate_eur FROM framework_rate fr
     WHERE fr.framework_id = ${projAlias}.framework_id
       AND fr.profile = ${profileExpr}
       AND fr.valid_from <= ${asnAlias}.start_date
     ORDER BY fr.valid_from DESC LIMIT 1)
  )
`);
