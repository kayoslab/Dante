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

// Booked hours from Personio v2 /attendance-periods. project_id refers to
// personio_project, not our internal project table.
//
// v2 model: one row per WORK period (breaks are separate BREAK periods,
// filtered out at sync time). `attendance_id` is the period's UUID; the
// v1 numeric id is gone (migration 0018 truncated + retyped the table).
// `duration_minutes` = (end − start) of that WORK period — breaks are
// already carved out between periods, so no subtraction. Multiple WORK
// rows per employee/day are expected and transparent to consumers, which
// all `SUM(duration_minutes) GROUP BY employee_id, work_date[, project_id]`.
// `start_time`/`end_time` now hold RFC3339 datetimes (not "HH:MM");
// `break_minutes` is retained but unused (null) in v2.
export const attendance = pgTable("attendance", {
  attendance_id: text().primaryKey(),
  employee_id: integer().notNull(),
  work_date: date({ mode: "string" }).notNull(),
  start_time: text(),
  end_time: text(),
  break_minutes: integer(),
  duration_minutes: integer(),
  project_id: text(),
  // v2 approval.status: PENDING / CONFIRMED / REJECTED. Captured for
  // future use, NOT yet consumed — this tenant auto-grants approval, so
  // every period is CONFIRMED today and the hour rollups deliberately
  // ignore status (count everything). Kept persisted so a later
  // "confirmed-only" or "drop rejected" view has the data without a
  // backfill. Do not prune as an unused column.
  status: text(),
  // v2 updated_at — drives the incremental (updated_at.gte) delta sync.
  updated_at: timestamp({ mode: "date" }),
  last_seen_sync_run_id: integer().notNull(),
});

// Personio's own "Projects" dropdown that consultants pick when logging time.
// v2 /projects ids are strings (e.g. "1234"), so the PK is text — matching
// the string `project.id` on v2 attendance periods and the wire type
// `lib/db/queries/personio.ts` already returns.
export const personioProject = pgTable("personio_project", {
  personio_project_id: text().primaryKey(),
  name: text().notNull(),
  active: boolean(),
  // v2 `billable` flag. For an UNLINKED Personio project this is the source
  // of truth for billability; for a LINKED one it only seeds the Dante
  // project's `billable` at link time (which then overrides). Nullable —
  // the flag is unreliable until the Personio admin curates it.
  billable: boolean(),
  // v2 subproject link: `parent_project.id` on the Personio project, or null
  // for a top-level project. Self-references `personio_project_id`; kept as a
  // plain nullable text (no FK) so an out-of-order sync — a child upserted
  // before its parent row exists — can't fail on a constraint. The link UI
  // resolves the parent name via a self-join.
  parent_id: text(),
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
  personio_project_id: text().primaryKey(),
  project_id: integer()
    .notNull()
    .references(() => project.project_id, { onDelete: "cascade" }),
  mapped_at: timestamp({ mode: "date" }).notNull(),
});
