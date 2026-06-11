import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// External freelancers staffed on projects. Fixed daily cost, no salary/burden.
export const freelancer = pgTable("freelancer", {
  freelancer_id: integer().generatedByDefaultAsIdentity().primaryKey(),
  name: text().notNull().unique(),
  daily_cost_eur: numeric({ precision: 10, scale: 2 }).notNull(),
  status: text().notNull().default("active"),
  contact_email: text(),
  notes: text(),
  created_at: timestamp({ mode: "date" }).notNull(),
  updated_at: timestamp({ mode: "date" }).notNull(),
});

// Key-value config. Read by margin views (burden_factor) and CLI commands.
export const setting = pgTable("setting", {
  key: text().primaryKey(),
  value: text().notNull(),
  description: text(),
  updated_at: timestamp({ mode: "date" }).notNull(),
});

export const customer = pgTable("customer", {
  customer_id: integer().generatedByDefaultAsIdentity().primaryKey(),
  name: text().notNull().unique(),
  notes: text(),
  created_at: timestamp({ mode: "date" }).notNull(),
  updated_at: timestamp({ mode: "date" }).notNull(),
});

export const frameworkAgreement = pgTable(
  "framework_agreement",
  {
    framework_id: integer().generatedByDefaultAsIdentity().primaryKey(),
    customer_id: integer().notNull(),
    name: text().notNull(),
    start_date: date({ mode: "string" }),
    end_date: date({ mode: "string" }),
    notes: text(),
    created_at: timestamp({ mode: "date" }).notNull(),
    updated_at: timestamp({ mode: "date" }).notNull(),
  },
  (t) => [unique("uq_framework_customer_name").on(t.customer_id, t.name)],
);

// (framework, profile, valid_from) versioned rate. Effective rate for a date
// is the row with the latest valid_from ≤ date.
export const frameworkRate = pgTable(
  "framework_rate",
  {
    framework_id: integer().notNull(),
    profile: text().notNull(),
    valid_from: date({ mode: "string" }).notNull(),
    daily_rate_eur: numeric({ precision: 10, scale: 2 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.framework_id, t.profile, t.valid_from] }),
  ],
);

export const project = pgTable(
  "project",
  {
    project_id: integer().generatedByDefaultAsIdentity().primaryKey(),
    customer_id: integer().notNull(),
    framework_id: integer(),
    name: text().notNull(),
    billing_model: text().notNull(), // 'time_and_material' | 'fixed_price'
    agreed_amount_eur: numeric({ precision: 12, scale: 2 }),
    planned_start_date: date({ mode: "string" }),
    planned_end_date: date({ mode: "string" }),
    status: text().notNull().default("active"),
    notes: text(),
    created_at: timestamp({ mode: "date" }).notNull(),
    updated_at: timestamp({ mode: "date" }).notNull(),
    // Phase B.4: hours budget, separate from agreed_amount_eur (Euro ceiling).
    time_budget_hours: integer(),
  },
  (t) => [unique("uq_project_customer_name").on(t.customer_id, t.name)],
);

// Project-level rate override / extension to framework rates. See db.py.
export const projectRate = pgTable(
  "project_rate",
  {
    project_id: integer().notNull(),
    profile: text().notNull(),
    valid_from: date({ mode: "string" }).notNull(),
    daily_rate_eur: numeric({ precision: 10, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.project_id, t.profile, t.valid_from] })],
);

// One assignment = one entity (employee OR freelancer) on one project for one
// time window. Exactly one of employee_id / freelancer_id is set per row
// (enforced in CRUD, not SQL — see db.py comment on FK constraints).
export const assignment = pgTable("assignment", {
  assignment_id: integer().generatedByDefaultAsIdentity().primaryKey(),
  employee_id: integer(),
  freelancer_id: integer(),
  project_id: integer().notNull(),
  profile: text(),
  allocation_pct: numeric({ precision: 5, scale: 4 }).notNull().default("1.0"),
  start_date: date({ mode: "string" }).notNull(),
  end_date: date({ mode: "string" }),
  daily_rate_override_eur: numeric({ precision: 10, scale: 2 }),
  daily_cost_override_eur: numeric({ precision: 10, scale: 2 }),
  notes: text(),
  created_at: timestamp({ mode: "date" }).notNull(),
  updated_at: timestamp({ mode: "date" }).notNull(),
});

// Monthly hours actually worked by a freelancer on a project, for
// profitability calc. SDM enters the number from the freelancer's
// invoice; awork sync may also fill rows with source='awork' (manual
// wins on conflict).
//
// The FK is to any assignment row; the action layer enforces that the
// linked assignment has `freelancer_id IS NOT NULL` since CHECK can't
// reference another table.
export const freelancerTimeEntry = pgTable(
  "freelancer_time_entry",
  {
    assignment_id: integer().notNull(),
    year_month: varchar({ length: 7 }).notNull(),
    hours_decimal: numeric({ precision: 8, scale: 2 }).notNull(),
    source: text().notNull().default("manual").$type<"manual" | "awork">(),
    entered_by: uuid(),
    entered_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.assignment_id, t.year_month] }),
    index("freelancer_time_entry_month_idx").on(t.year_month),
    check(
      "freelancer_time_entry_year_month_chk",
      sql`${t.year_month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "freelancer_time_entry_hours_nonneg_chk",
      sql`${t.hours_decimal} >= 0`,
    ),
    check(
      "freelancer_time_entry_source_chk",
      sql`${t.source} IN ('manual', 'awork')`,
    ),
  ],
);
