-- Every calculation follows the admin's overlap policy.
--
-- 0026 applied `time_entries.overlap_policy` only inside
-- `tracked_time_effective` (the tracked-hours report). Project cost,
-- revenue, FP burn and utilisation read `time_entry_resolved` directly and
-- deduplicated on their own by taking the larger source per (person, day),
-- regardless of which source the admin made leading. Linking a project in
-- a second tool could therefore pull the non-leading tool's hours into a
-- project's numbers.
--
-- `time_entry_effective` is `time_entry_resolved` with the policy applied:
--   - {kind: day_wins, integration: X}: any (person, day) that has time
--     from X drops every other source's time that day. A person is the
--     linked employee or freelancer; unlinked entries are kept as-is.
--   - {kind: merge} (or no rule row): everything is kept.
-- Every report reads this view and simply sums it.

DROP VIEW IF EXISTS "tracked_time_effective";
--> statement-breakpoint
CREATE VIEW "time_entry_effective" AS
WITH policy AS (
  SELECT value ->> 'kind' AS kind, value ->> 'integration' AS winner
  FROM integration_rule
  WHERE capability = 'time_entries' AND key = 'overlap_policy'
)
SELECT r.*
FROM time_entry_resolved r
WHERE NOT (
  (SELECT kind FROM policy) = 'day_wins'
  AND r.integration_slug IS DISTINCT FROM (SELECT winner FROM policy)
  AND EXISTS (
    SELECT 1 FROM time_entry_resolved w
    WHERE w.integration_slug = (SELECT winner FROM policy)
      AND w.work_date = r.work_date
      AND (
        (r.employee_id IS NOT NULL AND w.employee_id = r.employee_id)
        OR (r.freelancer_id IS NOT NULL AND w.freelancer_id = r.freelancer_id)
      )
  )
);
--> statement-breakpoint
-- Same columns as the 0026 definition, now on the policy-applied view.
CREATE VIEW "tracked_time_effective" AS
WITH hris AS (
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
FROM time_entry_effective r
LEFT JOIN project p ON p.project_id = r.project_id
WHERE r.employee_id IS NOT NULL;
