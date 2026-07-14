-- Migrate the Personio attendance + projects sync from the deprecated v1
-- REST endpoints to the v2 API. v1 /company/attendances and
-- /company/attendances/projects sunset 2026-08-30.
--
-- v2 changes the id types: attendance periods are UUID strings and
-- Personio project ids are strings (e.g. "1234"), so three columns move
-- integer/bigint -> text.
--
--   1. `attendance` is TRUNCATED. Its v1 rows are keyed by a numeric id
--      that v2 no longer issues (v2 ids are per-period UUIDs); leaving
--      them would double-count days once the v2 backfill lands, since the
--      same day arrives again under new UUID keys. Attendance is fully
--      reconstructable from Personio, so the next sync refills it (the
--      first post-deploy run does a full-window backfill).
--   2. `attendance` gains `status` (v2 approval.status) and `updated_at`
--      (v2 updated_at — drives the incremental updated_at.gte delta sync).
--      `project_id` becomes text (v2 project.id is a string).
--   3. `personio_project` / `personio_project_link`.personio_project_id
--      keep their VALUES (integer 82173 -> text "82173", the same id v2
--      returns) via a ::text cast, so existing operator-created
--      project->Dante mappings in personio_project_link survive.

TRUNCATE TABLE "attendance";
--> statement-breakpoint
ALTER TABLE "attendance" ALTER COLUMN "attendance_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "attendance" ALTER COLUMN "project_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "status" text;
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "personio_project" ALTER COLUMN "personio_project_id" SET DATA TYPE text USING "personio_project_id"::text;
--> statement-breakpoint
ALTER TABLE "personio_project_link" ALTER COLUMN "personio_project_id" SET DATA TYPE text USING "personio_project_id"::text;
