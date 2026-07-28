import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { project } from "./billing";

// awork's "Companies" = customers in their model.
export const aworkCompany = pgTable("awork_company", {
  awork_company_id: text().primaryKey(),
  name: text(),
  is_external: boolean(),
  projects_count: integer(),
  projects_in_progress_count: integer(),
  created_on: timestamp({ mode: "date" }),
  updated_on: timestamp({ mode: "date" }),
  last_seen_sync_run_id: integer(),
  last_updated_at: timestamp({ mode: "date" }),
});

// awork users — mapped to our employees by email at sync time.
export const aworkUser = pgTable("awork_user", {
  awork_user_id: text().primaryKey(),
  first_name: text(),
  last_name: text(),
  email: text(),
  position: text(),
  title: text(),
  is_agent: boolean(),
  is_archived: boolean(),
  is_deactivated: boolean(),
  is_external: boolean(),
  status: text(),
  created_on: timestamp({ mode: "date" }),
  last_seen_sync_run_id: integer(),
  last_updated_at: timestamp({ mode: "date" }),
});

export const aworkProject = pgTable("awork_project", {
  awork_project_id: text().primaryKey(),
  name: text(),
  project_key: text(),
  awork_company_id: text(),
  is_billable_by_default: boolean(),
  is_external: boolean(),
  is_private: boolean(),
  is_retainer: boolean(),
  project_status_id: text(),
  description: text(),
  tasks_count: integer(),
  tasks_done_count: integer(),
  created_on: timestamp({ mode: "date" }),
  updated_on: timestamp({ mode: "date" }),
  last_seen_sync_run_id: integer(),
  last_updated_at: timestamp({ mode: "date" }),
  // Phase B.4 additions: data used to pre-fill our project on import.
  start_date: date({ mode: "string" }),
  due_date: date({ mode: "string" }),
  closed_on: date({ mode: "string" }),
  time_budget_seconds: bigint({ mode: "number" }),
  project_status_type: text(),
  project_status_name: text(),
  daily_rate_eur: numeric({ precision: 12, scale: 2 }),
  fixed_price_eur: numeric({ precision: 12, scale: 2 }),
  order_number: text(),
});

// One row per logged time entry. duration_minutes derived from
// duration_seconds for compatibility with Personio attendance semantics.
export const aworkTimeEntry = pgTable(
  "awork_time_entry",
  {
    awork_time_entry_id: text().primaryKey(),
    awork_user_id: text(),
    awork_project_id: text(),
    awork_task_id: text(),
    work_date: date({ mode: "string" }),
    duration_seconds: integer(),
    duration_minutes: integer(),
    is_billable: boolean(),
    is_billed: boolean(),
    note: text(),
    type_of_work_id: text(),
    type_of_work_name: text(),
    start_date_utc: timestamp({ mode: "date" }),
    end_date_utc: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer(),
  },
  (t) => [
    // Sibling of the attendance indexes: tracked-hours rollups filter by
    // date window, the awork-day dedup probes (user, date), project views
    // aggregate by project.
    index("awork_time_entry_user_date_idx").on(t.awork_user_id, t.work_date),
    index("awork_time_entry_date_idx").on(t.work_date),
    index("awork_time_entry_project_idx").on(t.awork_project_id),
  ],
);

// awork "time bookings" — the entries rendered on awork's Planner page.
// One row per (user, project, date range) planning entry. Project-only
// (no task field), duration is the total for the whole range — the
// calendar route distributes it evenly across working days when
// rendering. Indexes serve "what's planned for this user in this
// window?" lookups; see migration 0013_awork_time_booking.sql.
export const aworkTimeBooking = pgTable("awork_time_booking", {
  awork_time_booking_id: text().primaryKey(),
  awork_user_id: text().notNull(),
  awork_project_id: text().notNull(),
  start_date: date({ mode: "string" }).notNull(),
  end_date: date({ mode: "string" }).notNull(),
  duration_seconds: integer().notNull(),
  lane_order: integer(),
  description: text(),
  created_on: timestamp({ mode: "date" }),
  updated_on: timestamp({ mode: "date" }),
  last_seen_sync_run_id: integer().notNull(),
});

// awork projects → our project table. PK on awork side: each awork project
// maps to at most one of ours. project_id cascades from project so deleting
// a Dante project removes its awork link too (same gap as
// `personio_project_link` — see that table's comment).
export const aworkProjectLink = pgTable("awork_project_link", {
  awork_project_id: text().primaryKey(),
  project_id: integer()
    .notNull()
    .references(() => project.project_id, { onDelete: "cascade" }),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});

// awork users → our employee_current.
export const aworkUserLink = pgTable("awork_user_link", {
  awork_user_id: text().primaryKey(),
  employee_id: integer().notNull(),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});

// awork users → our freelancer table. Separate from awork_user_link
// because the same awork_user_id belongs to exactly one (employee XOR
// freelancer) — keeping the two FKs in separate tables avoids the
// nullable/XOR dance and lets each auto-linker run independently.
export const aworkFreelancerLink = pgTable("awork_freelancer_link", {
  awork_user_id: text().primaryKey(),
  freelancer_id: integer().notNull(),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});

// awork companies → our customer.
export const aworkCompanyLink = pgTable("awork_company_link", {
  awork_company_id: text().primaryKey(),
  customer_id: integer().notNull(),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});
