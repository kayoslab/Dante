/** Mapping from Personio attribute keys to employee_current columns.
 *
 * Verbatim port of src/dante/attribute_map.py. The act-digital-deutschland
 * instance keeps compensation in standard attributes (no custom
 * `dynamic_NNNNNN` mapping for salary); custom attribute slots are reserved
 * for birth_date / nationality / notice_period_probation only. Verify the
 * dynamic_ IDs in your Personio instance if they change.
 */
export const STANDARD_ATTRIBUTES: Record<string, string> = {
  id: "employee_id",
  first_name: "first_name",
  last_name: "last_name",
  email: "email",
  status: "status",
  hire_date: "hire_date",
  contract_end_date: "contract_end_date",
  employment_type: "employment_type",
  weekly_working_hours: "weekly_working_hours",
  department: "department",
  position: "position",
  subcompany: "subcompany",
  office: "office",
  supervisor: "supervisor_id",
  fix_salary: "fix_salary",
  fix_salary_interval: "fix_salary_interval",
  hourly_salary: "hourly_salary",
  cost_centers: "cost_center",
  // Added after admin extended credential scope (2026-06):
  gender: "gender",
  probation_period_end: "probation_period_end",
  // absence_entitlement is a nested list of TimeOffType objects; the sync
  // stores the whole structure as jsonb (see flattenEmployee).
  absence_entitlement: "absence_entitlement",
};

export const CUSTOM_ATTRIBUTES: Record<string, string> = {
  dynamic_1443673: "birth_date",
  dynamic_1443693: "nationality",
  dynamic_1640038: "notice_period_probation",
};

/** Columns whose value should be preserved as a structured JSON value
 * rather than reduced via `_extract`. */
export const JSON_COLUMNS = new Set<string>(["absence_entitlement"]);

/** All employee_current columns the sync writes, in the canonical INSERT order. */
export const EMPLOYEE_COLUMNS = [
  "employee_id",
  "first_name",
  "last_name",
  "email",
  "status",
  "department",
  "position",
  "subcompany",
  "office",
  "hire_date",
  "contract_end_date",
  "employment_type",
  "weekly_working_hours",
  "supervisor_id",
  "fix_salary",
  "fix_salary_interval",
  "hourly_salary",
  "cost_center",
  // Added after admin scope expansion (2026-06):
  "gender",
  "probation_period_end",
  "birth_date",
  "nationality",
  "notice_period_probation",
  "absence_entitlement",
  // From Personio v2 /persons/{id}/employments — actual leaving date.
  // v1's contract_end_date only fires for fixed-term contracts.
  "employment_end_date",
] as const;

export type EmployeeColumn = (typeof EMPLOYEE_COLUMNS)[number];

const DATE_COLUMNS = new Set<EmployeeColumn>([
  "hire_date",
  "contract_end_date",
  "probation_period_end",
  "birth_date",
  "employment_end_date",
]);
const NUMERIC_COLUMNS = new Set<EmployeeColumn>([
  "weekly_working_hours",
  "fix_salary",
  "hourly_salary",
]);

export function isDateColumn(c: string): c is EmployeeColumn {
  return DATE_COLUMNS.has(c as EmployeeColumn);
}
export function isNumericColumn(c: string): c is EmployeeColumn {
  return NUMERIC_COLUMNS.has(c as EmployeeColumn);
}

