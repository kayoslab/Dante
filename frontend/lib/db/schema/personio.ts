import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { project } from "./billing";

// Time-off / absence records from Personio /company/time-offs. Sync replaces
// rows within the synced date window (no soft delete).
export const absence = pgTable("absence", {
  absence_id: bigint({ mode: "number" }).primaryKey(),
  employee_id: integer().notNull(),
  time_off_type: text(),
  start_date: date({ mode: "string" }).notNull(),
  end_date: date({ mode: "string" }).notNull(),
  half_day_start: boolean(),
  half_day_end: boolean(),
  days_count: doublePrecision(),
  status: text(),
  comment: text(),
  last_seen_sync_run_id: integer().notNull(),
});

// Booked hours from /company/attendances. project_id refers to personio_project,
// not our internal project table. Same replace-in-window strategy as absence.
export const attendance = pgTable("attendance", {
  attendance_id: bigint({ mode: "number" }).primaryKey(),
  employee_id: integer().notNull(),
  work_date: date({ mode: "string" }).notNull(),
  start_time: text(),
  end_time: text(),
  break_minutes: integer(),
  duration_minutes: integer(),
  project_id: integer(),
  comment: text(),
  last_seen_sync_run_id: integer().notNull(),
});

// Personio's own "Projects" dropdown that consultants pick when logging time.
export const personioProject = pgTable("personio_project", {
  personio_project_id: integer().primaryKey(),
  name: text().notNull(),
  active: boolean(),
  last_seen_sync_run_id: integer(),
  last_updated_at: timestamp({ mode: "date" }),
});

// Mapping: each Personio project maps to at most one of our internal projects.
// Unmapped Personio projects are treated as "internal time".
//
// project_id cascades from project — when a Dante project is deleted, its
// Personio link row goes with it. Without the cascade, deleting a project
// orphans the link: `personio_project_link.project_id` points at a now-
// missing project row, the picker on `/projects/<id>` still treats the
// Personio project as "mapped", and you can't link it to a new Dante
// project without manually cleaning the orphan.
export const personioProjectLink = pgTable("personio_project_link", {
  personio_project_id: integer().primaryKey(),
  project_id: integer()
    .notNull()
    .references(() => project.project_id, { onDelete: "cascade" }),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});
