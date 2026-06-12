-- awork "time bookings" — the data rendered on awork's Planner page.
-- One row per user-on-project-for-a-date-range planning entry. Unlike
-- time entries, these are project-only (no task), have a date range
-- (`start_date`/`end_date`) rather than a single timestamp, and the
-- `duration` is the total planned for the whole range — the UI
-- distributes it across working days when rendering.
CREATE TABLE "awork_time_booking" (
  "awork_time_booking_id" text PRIMARY KEY,
  "awork_user_id" text NOT NULL,
  "awork_project_id" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "duration_seconds" integer NOT NULL,
  "lane_order" integer,
  "description" text,
  "created_on" timestamp,
  "updated_on" timestamp,
  "last_seen_sync_run_id" integer NOT NULL,
  CONSTRAINT "awork_time_booking_dates_chk" CHECK ("start_date" <= "end_date"),
  CONSTRAINT "awork_time_booking_duration_chk" CHECK ("duration_seconds" >= 0)
);
--> statement-breakpoint

-- Hot lookup: "what's planned for this user in this window?" — used by
-- the calendar route's per-employee per-day join.
CREATE INDEX "awork_time_booking_user_dates_idx"
  ON "awork_time_booking" ("awork_user_id", "start_date", "end_date");

CREATE INDEX "awork_time_booking_project_idx"
  ON "awork_time_booking" ("awork_project_id");
