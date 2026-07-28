import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Latest known state per employee. employee_id is Personio's own id (not
// generated). Upserted by sync.py on every run.
export const employeeCurrent = pgTable("employee_current", {
  employee_id: integer().primaryKey(),
  first_name: text(),
  last_name: text(),
  email: text(),
  status: text(),
  department: text(),
  position: text(),
  subcompany: text(),
  office: text(),
  hire_date: date({ mode: "string" }),
  contract_end_date: date({ mode: "string" }),
  // Populated from v2 /persons/{id}/employments (see Personio v1↔v2 end-date split memory).
  employment_end_date: date({ mode: "string" }),
  employment_type: text(),
  weekly_working_hours: doublePrecision(),
  supervisor_id: integer(),
  fix_salary: numeric({ precision: 12, scale: 2 }),
  fix_salary_interval: text(),
  hourly_salary: numeric({ precision: 12, scale: 2 }),
  cost_center: text(),
  gender: text(),
  probation_period_end: date({ mode: "string" }),
  birth_date: date({ mode: "string" }),
  nationality: text(),
  notice_period_probation: text(),
  absence_entitlement: jsonb(),
  last_seen_sync_run_id: integer().notNull(),
  last_updated_at: timestamp({ mode: "date" }).notNull(),
});

// Curated overrides not sourced from Personio. team_user is denormalized
// (mirrors team.team_name) so GROUP BY team works without a join.
export const employeeAnnotation = pgTable("employee_annotation", {
  employee_id: integer().primaryKey(),
  team_user: text(),
  is_multi_org: boolean(),
  is_real_employee: boolean(),
  is_project_contributing: boolean(),
  role_tier: text(),
  last_reconciled_at: timestamp({ mode: "date" }).notNull(),
});

// Canonical team list; membership lives in employee_annotation.team_user.
export const team = pgTable("team", {
  team_name: text().primaryKey(),
  created_at: timestamp({ mode: "date" }).notNull(),
  updated_at: timestamp({ mode: "date" }).notNull(),
});

// Per-component compensation from Personio v2 Compensations API. Current
// state per component, not change history. See db.py for full notes on
// categories (FIXED_SALARY / RECURRING / HOURLY_SALARY / ONE_TIME).
export const compensationEvent = pgTable(
  "compensation_event",
  {
    compensation_id: text().primaryKey(),
    employee_id: integer().notNull(),
    effective_from: date({ mode: "string" }),
    amount_value: numeric({ precision: 12, scale: 2 }),
    amount_currency: text(),
    interval: text(),
    category: text(),
    type_name: text(),
    legal_entity_id: text(),
    weekly_working_hours: doublePrecision(),
    full_time_weekly_working_hours: doublePrecision(),
    last_seen_sync_run_id: integer().notNull(),
    last_updated_at: timestamp({ mode: "date" }).notNull(),
  },
  (t) => [
    // The as-of salary LATERAL runs once per employee per report month.
    index("compensation_event_employee_from_idx").on(
      t.employee_id,
      t.effective_from,
    ),
  ],
);

// Forward-built salary change log: sync_compensations appends a row each
// time the (effective_from, amount) pair changes vs the prior snapshot.
// uq_salary_event guards against double-appending the same change.
export const salaryChangeEvent = pgTable(
  "salary_change_event",
  {
    event_id: integer().generatedByDefaultAsIdentity().primaryKey(),
    employee_id: integer().notNull(),
    effective_date: date({ mode: "string" }).notNull(),
    old_annual_eur: numeric({ precision: 12, scale: 2 }),
    new_annual_eur: numeric({ precision: 12, scale: 2 }),
    source: text().notNull(),
  },
  (t) => [
    unique("uq_salary_event").on(
      t.employee_id,
      t.effective_date,
      t.new_annual_eur,
    ),
  ],
);
