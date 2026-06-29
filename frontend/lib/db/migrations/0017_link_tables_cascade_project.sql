-- Cascade Dante project deletion through the integration link tables.
--
-- `personio_project_link.project_id` and `awork_project_link.project_id`
-- both reference `project.project_id` semantically but had no SQL-level
-- FK. Deleting a Dante project left the link row orphaned: the picker on
-- `/projects/<id>` still treated the Personio/awork side as "mapped" (a
-- link row exists), making it impossible to re-link to a new project
-- without manually cleaning the orphan. Same hole on the awork side.
--
-- This migration:
--   1. Sweeps any existing orphan rows so the FK creation doesn't
--      violate the constraint. Idempotent — runs the WHERE-NOT-EXISTS
--      delete every apply, no-ops once clean.
--   2. Adds ON DELETE CASCADE FKs so future project deletions clean
--      their link rows automatically.

DELETE FROM "personio_project_link" ppl
WHERE NOT EXISTS (
  SELECT 1 FROM "project" p WHERE p."project_id" = ppl."project_id"
);
--> statement-breakpoint
DELETE FROM "awork_project_link" apl
WHERE NOT EXISTS (
  SELECT 1 FROM "project" p WHERE p."project_id" = apl."project_id"
);
--> statement-breakpoint

ALTER TABLE "personio_project_link"
  ADD CONSTRAINT "personio_project_link_project_id_project_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "project"("project_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "awork_project_link"
  ADD CONSTRAINT "awork_project_link_project_id_project_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "project"("project_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
