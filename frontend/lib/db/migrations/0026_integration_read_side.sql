-- Integration model — phase 5 of docs/integration-adapters.md.
--
-- The read side moves onto the canonical tables, so the compatibility
-- views that stood in for the provider tables since 0024 go away. Two
-- "resolved" views carry the joins every report needs (person → employee /
-- freelancer, project → Dante project, project name + source billability),
-- and `tracked_time_effective` is rebuilt on them, driven by the admin's
-- rules instead of hard-coded provider names:
--
--   - `time_entries.overlap_policy` (integration_rule): with
--     {kind: day_wins, integration: X}, any (employee, day) that has time
--     from X drops every other source's time that day; {kind: merge}
--     keeps everything.
--   - the primary `people` binding: time without a project from the HRIS
--     is "untagged" (attendance logged with no project); time without a
--     project from any other source counts as billable, as before.
--
-- Also: an awork person's `is_active` now mirrors only `is_archived`
-- (deactivated-but-not-archived users stay visible in link pickers, the
-- behaviour the old picker had).

DROP VIEW IF EXISTS "tracked_time_effective";
--> statement-breakpoint
DROP VIEW IF EXISTS "attendance";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_time_entry";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_time_booking";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_user";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_company";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_project";
--> statement-breakpoint
DROP VIEW IF EXISTS "personio_project";
--> statement-breakpoint
DROP VIEW IF EXISTS "personio_project_link";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_project_link";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_user_link";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_freelancer_link";
--> statement-breakpoint
DROP VIEW IF EXISTS "awork_company_link";
--> statement-breakpoint
UPDATE "external_person"
   SET is_active = NOT COALESCE((extra ->> 'is_archived')::boolean, false)
 WHERE integration_slug = 'awork';
--> statement-breakpoint
-- Every time entry with its Dante resolution. `employee_id` / `freelancer_id`
-- come from the person link (exactly one of them, or neither when the
-- person is unlinked); `project_id` from the project link; the source's own
-- project name and billability flag ride along for unlinked projects.
CREATE VIEW "time_entry_resolved" AS
SELECT t.integration_slug,
       t.external_id,
       t.work_date,
       t.duration_minutes,
       t.is_billable,
       t.external_person_id,
       t.external_project_id,
       CASE WHEN pl.dante_type = 'employee'   THEN pl.dante_id END AS employee_id,
       CASE WHEN pl.dante_type = 'freelancer' THEN pl.dante_id END AS freelancer_id,
       prl.dante_id AS project_id,
       ep.name AS external_project_name,
       ep.billable AS source_billable
FROM time_entry t
LEFT JOIN external_link pl
  ON pl.integration_slug = t.integration_slug AND pl.entity_type = 'person'
 AND pl.external_id = t.external_person_id
LEFT JOIN external_link prl
  ON prl.integration_slug = t.integration_slug AND prl.entity_type = 'project'
 AND prl.external_id = t.external_project_id
LEFT JOIN external_project ep
  ON ep.integration_slug = t.integration_slug AND ep.external_id = t.external_project_id;
--> statement-breakpoint
CREATE VIEW "planned_booking_resolved" AS
SELECT b.integration_slug,
       b.external_id,
       b.start_date,
       b.end_date,
       b.duration_seconds,
       b.external_person_id,
       b.external_project_id,
       CASE WHEN pl.dante_type = 'employee'   THEN pl.dante_id END AS employee_id,
       CASE WHEN pl.dante_type = 'freelancer' THEN pl.dante_id END AS freelancer_id,
       prl.dante_id AS project_id,
       ep.name AS external_project_name
FROM planned_booking b
LEFT JOIN external_link pl
  ON pl.integration_slug = b.integration_slug AND pl.entity_type = 'person'
 AND pl.external_id = b.external_person_id
LEFT JOIN external_link prl
  ON prl.integration_slug = b.integration_slug AND prl.entity_type = 'project'
 AND prl.external_id = b.external_project_id
LEFT JOIN external_project ep
  ON ep.integration_slug = b.integration_slug AND ep.external_id = b.external_project_id;
--> statement-breakpoint
-- Tracked time per employee with effective billability and the admin's
-- overlap rule applied. Same columns as the 0022 definition.
CREATE VIEW "tracked_time_effective" AS
WITH policy AS (
  SELECT value ->> 'kind' AS kind, value ->> 'integration' AS winner
  FROM integration_rule
  WHERE capability = 'time_entries' AND key = 'overlap_policy'
),
hris AS (
  SELECT integration_slug
  FROM integration_binding
  WHERE capability = 'people' AND priority = 0 AND enabled
)
SELECT r.employee_id,
       r.work_date,
       CASE
         WHEN r.external_project_id IS NULL
              AND r.integration_slug IN (SELECT integration_slug FROM hris) THEN 'untagged'
         WHEN r.project_id IS NOT NULL
           THEN CASE WHEN p.billable THEN 'billable' ELSE 'non_billable' END
         ELSE CASE WHEN COALESCE(r.source_billable, TRUE) THEN 'billable' ELSE 'non_billable' END
       END AS bucket,
       r.duration_minutes,
       r.integration_slug AS source
FROM time_entry_resolved r
LEFT JOIN project p ON p.project_id = r.project_id
WHERE r.employee_id IS NOT NULL
  AND NOT (
    (SELECT kind FROM policy) = 'day_wins'
    AND r.integration_slug IS DISTINCT FROM (SELECT winner FROM policy)
    AND EXISTS (
      SELECT 1 FROM time_entry_resolved w
      WHERE w.integration_slug = (SELECT winner FROM policy)
        AND w.employee_id = r.employee_id
        AND w.work_date = r.work_date
    )
  );
