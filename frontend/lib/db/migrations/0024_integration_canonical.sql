-- Integration model — phase 2 of docs/integration-adapters.md.
--
-- The adapters now write the canonical tables introduced in 0023, so the
-- provider-shaped tables retire here. Behaviour-neutral for every reader:
-- each legacy table comes back as a VIEW with the same name and columns
-- over the canonical data, and the two report views that depended on them
-- are recreated unchanged. Phase 5 moves the readers and drops the views.
--
-- 1. `absence` / `compensation_event` gain `integration_slug` and move to
--    a (slug, external id) primary key. Rows are untouched; the legacy
--    numeric `absence_id` stays as a nullable column.
-- 2. Existing rows are copied into the canonical tables: awork_user →
--    external_person, awork_company → external_company, awork_project +
--    personio_project → external_project, attendance + awork_time_entry →
--    time_entry, awork_time_booking → planned_booking. Provider-specific
--    columns land in `extra`.
-- 3. The phase-1 mirror triggers go (the runner writes external_link
--    directly now); the legacy tables are dropped and recreated as views;
--    `tracked_time_effective` is recreated with its 0022 definition.
-- 4. external_link rows follow their Dante entity: deleting a project /
--    customer / freelancer / employee removes its links (the FK cascades
--    the legacy link tables had, generalised).

-- ---------------------------------------------------------------------------
-- 1. absence / compensation_event: canonical keys
-- ---------------------------------------------------------------------------
ALTER TABLE "absence" ADD COLUMN "integration_slug" text DEFAULT 'personio' NOT NULL;
--> statement-breakpoint
ALTER TABLE "absence" ADD COLUMN "external_id" text;
--> statement-breakpoint
UPDATE "absence" SET "external_id" = "absence_id"::text;
--> statement-breakpoint
ALTER TABLE "absence" ALTER COLUMN "external_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "absence" ALTER COLUMN "integration_slug" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "absence" DROP CONSTRAINT "absence_pkey";
--> statement-breakpoint
ALTER TABLE "absence" ALTER COLUMN "absence_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id");
--> statement-breakpoint
ALTER TABLE "absence"
	ADD CONSTRAINT "absence_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "compensation_event" ADD COLUMN "integration_slug" text DEFAULT 'personio' NOT NULL;
--> statement-breakpoint
ALTER TABLE "compensation_event" ALTER COLUMN "integration_slug" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "compensation_event" DROP CONSTRAINT "compensation_event_pkey";
--> statement-breakpoint
ALTER TABLE "compensation_event" ADD CONSTRAINT "compensation_event_integration_slug_compensation_id_pk" PRIMARY KEY ("integration_slug", "compensation_id");
--> statement-breakpoint
ALTER TABLE "compensation_event"
	ADD CONSTRAINT "compensation_event_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- awork time entries can arrive without a user (193 such rows in one
-- workspace); they still count toward their project.
ALTER TABLE "time_entry" ALTER COLUMN "external_person_id" DROP NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Copy legacy rows into the canonical tables
-- ---------------------------------------------------------------------------
INSERT INTO "external_person"
	("integration_slug", "external_id", "first_name", "last_name", "email", "status", "is_active", "is_external",
	 "extra", "source_updated_at", "last_seen_sync_run_id", "last_updated_at")
SELECT 'awork', awork_user_id, first_name, last_name, email, status,
       NOT COALESCE(is_archived, false) AND NOT COALESCE(is_deactivated, false), is_external,
       jsonb_build_object(
         'position', position, 'title', title, 'is_agent', is_agent, 'is_archived', is_archived,
         'is_deactivated', is_deactivated, 'created_on', created_on),
       NULL, last_seen_sync_run_id, COALESCE(last_updated_at, now())
FROM awork_user
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "external_person"
	("integration_slug", "external_id", "first_name", "last_name", "email", "status", "is_active", "is_external",
	 "extra", "source_updated_at", "last_seen_sync_run_id", "last_updated_at")
SELECT 'personio', l.external_id, ec.first_name, ec.last_name, ec.email, ec.status,
       CASE WHEN ec.status IS NULL THEN NULL ELSE lower(ec.status) = 'active' END, false,
       '{}'::jsonb, NULL, ec.last_seen_sync_run_id, ec.last_updated_at
FROM employee_current ec
JOIN external_link l
  ON l.integration_slug = 'personio' AND l.entity_type = 'person'
 AND l.dante_type = 'employee' AND l.dante_id = ec.employee_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "external_company"
	("integration_slug", "external_id", "name", "is_external", "extra", "source_updated_at",
	 "last_seen_sync_run_id", "last_updated_at")
SELECT 'awork', awork_company_id, name, is_external,
       jsonb_build_object(
         'projects_count', projects_count, 'projects_in_progress_count', projects_in_progress_count,
         'created_on', created_on),
       updated_on, last_seen_sync_run_id, COALESCE(last_updated_at, now())
FROM awork_company
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "external_project"
	("integration_slug", "external_id", "name", "project_key", "external_company_id", "parent_external_id",
	 "billable", "active", "status_type", "status_name", "start_date", "due_date", "closed_on",
	 "time_budget_seconds", "description", "extra", "source_updated_at", "last_seen_sync_run_id", "last_updated_at")
SELECT 'awork', awork_project_id, name, project_key, awork_company_id, NULL,
       is_billable_by_default,
       CASE WHEN project_status_type IS NULL THEN NULL
            ELSE project_status_type NOT IN ('closed', 'archived') END,
       project_status_type, project_status_name, start_date, due_date, closed_on,
       time_budget_seconds, description,
       jsonb_build_object(
         'is_external', is_external, 'is_private', is_private, 'is_retainer', is_retainer,
         'project_status_id', project_status_id, 'tasks_count', tasks_count,
         'tasks_done_count', tasks_done_count, 'created_on', created_on,
         'daily_rate_eur', daily_rate_eur::text, 'fixed_price_eur', fixed_price_eur::text,
         'order_number', order_number),
       updated_on, last_seen_sync_run_id, COALESCE(last_updated_at, now())
FROM awork_project
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "external_project"
	("integration_slug", "external_id", "name", "project_key", "external_company_id", "parent_external_id",
	 "billable", "active", "status_type", "status_name", "start_date", "due_date", "closed_on",
	 "time_budget_seconds", "description", "extra", "source_updated_at", "last_seen_sync_run_id", "last_updated_at")
SELECT 'personio', personio_project_id, name, NULL, NULL, parent_id,
       billable, active, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       '{}'::jsonb, NULL, last_seen_sync_run_id, COALESCE(last_updated_at, now())
FROM personio_project
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "time_entry"
	("integration_slug", "external_id", "external_person_id", "external_project_id", "external_task_id",
	 "work_date", "start_at", "end_at", "duration_minutes", "is_billable", "is_billed", "status", "note",
	 "type_of_work", "extra", "source_updated_at", "last_seen_sync_run_id")
SELECT 'personio', attendance_id, employee_id::text, project_id, NULL,
       work_date,
       CASE WHEN start_time ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN start_time::timestamp END,
       CASE WHEN end_time   ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN end_time::timestamp END,
       COALESCE(duration_minutes, 0), NULL, NULL, status, NULL, NULL,
       jsonb_strip_nulls(jsonb_build_object(
         'start_raw', start_time, 'end_raw', end_time, 'break_minutes', break_minutes)),
       updated_at, COALESCE(last_seen_sync_run_id, 0)
FROM attendance
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "time_entry"
	("integration_slug", "external_id", "external_person_id", "external_project_id", "external_task_id",
	 "work_date", "start_at", "end_at", "duration_minutes", "is_billable", "is_billed", "status", "note",
	 "type_of_work", "extra", "source_updated_at", "last_seen_sync_run_id")
SELECT 'awork', awork_time_entry_id, awork_user_id, awork_project_id, awork_task_id,
       work_date, start_date_utc, end_date_utc, COALESCE(duration_minutes, 0),
       is_billable, is_billed, NULL, note, type_of_work_name,
       jsonb_build_object('duration_seconds', duration_seconds, 'type_of_work_id', type_of_work_id),
       NULL, COALESCE(last_seen_sync_run_id, 0)
FROM awork_time_entry
WHERE work_date IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "planned_booking"
	("integration_slug", "external_id", "external_person_id", "external_project_id", "start_date", "end_date",
	 "duration_seconds", "description", "extra", "source_created_at", "source_updated_at", "last_seen_sync_run_id")
SELECT 'awork', awork_time_booking_id, awork_user_id, awork_project_id, start_date, end_date,
       duration_seconds, description, jsonb_build_object('lane_order', lane_order),
       created_on, updated_on, last_seen_sync_run_id
FROM awork_time_booking
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Retire the legacy tables; recreate them as views
-- ---------------------------------------------------------------------------
DROP VIEW "tracked_time_effective";
--> statement-breakpoint
DROP TRIGGER "personio_project_link_mirror" ON "personio_project_link";
--> statement-breakpoint
DROP TRIGGER "awork_project_link_mirror" ON "awork_project_link";
--> statement-breakpoint
DROP TRIGGER "awork_user_link_mirror" ON "awork_user_link";
--> statement-breakpoint
DROP TRIGGER "awork_freelancer_link_mirror" ON "awork_freelancer_link";
--> statement-breakpoint
DROP TRIGGER "awork_company_link_mirror" ON "awork_company_link";
--> statement-breakpoint
DROP TRIGGER "employee_current_personio_link_mirror" ON "employee_current";
--> statement-breakpoint
DROP FUNCTION external_link_mirror();
--> statement-breakpoint
DROP TABLE "awork_freelancer_link";
--> statement-breakpoint
DROP TABLE "awork_user_link";
--> statement-breakpoint
DROP TABLE "awork_company_link";
--> statement-breakpoint
DROP TABLE "awork_project_link";
--> statement-breakpoint
DROP TABLE "personio_project_link";
--> statement-breakpoint
DROP TABLE "awork_time_entry";
--> statement-breakpoint
DROP TABLE "awork_time_booking";
--> statement-breakpoint
DROP TABLE "awork_project";
--> statement-breakpoint
DROP TABLE "awork_user";
--> statement-breakpoint
DROP TABLE "awork_company";
--> statement-breakpoint
DROP TABLE "personio_project";
--> statement-breakpoint
DROP TABLE "attendance";
--> statement-breakpoint
-- Compatibility views. Same names, same columns as the tables they
-- replace. `employee_id` on `attendance` resolves through external_link
-- (falls back to the numeric external id for rows that predate links).
CREATE VIEW "attendance" AS
SELECT t.external_id AS attendance_id,
       COALESCE(l.dante_id,
                CASE WHEN t.external_person_id ~ '^\d+$' THEN t.external_person_id::integer END) AS employee_id,
       t.work_date,
       COALESCE(t.extra ->> 'start_raw', to_char(t.start_at, 'YYYY-MM-DD"T"HH24:MI:SS')) AS start_time,
       COALESCE(t.extra ->> 'end_raw',   to_char(t.end_at,   'YYYY-MM-DD"T"HH24:MI:SS')) AS end_time,
       (t.extra ->> 'break_minutes')::integer AS break_minutes,
       t.duration_minutes,
       t.external_project_id AS project_id,
       t.status,
       t.source_updated_at AS updated_at,
       t.last_seen_sync_run_id
FROM time_entry t
LEFT JOIN external_link l
  ON l.integration_slug = t.integration_slug AND l.entity_type = 'person'
 AND l.external_id = t.external_person_id AND l.dante_type = 'employee'
WHERE t.integration_slug = 'personio';
--> statement-breakpoint
CREATE VIEW "awork_time_entry" AS
SELECT external_id AS awork_time_entry_id,
       external_person_id AS awork_user_id,
       external_project_id AS awork_project_id,
       external_task_id AS awork_task_id,
       work_date,
       (extra ->> 'duration_seconds')::integer AS duration_seconds,
       duration_minutes,
       is_billable,
       is_billed,
       note,
       extra ->> 'type_of_work_id' AS type_of_work_id,
       type_of_work AS type_of_work_name,
       start_at AS start_date_utc,
       end_at AS end_date_utc,
       last_seen_sync_run_id
FROM time_entry
WHERE integration_slug = 'awork';
--> statement-breakpoint
CREATE VIEW "awork_time_booking" AS
SELECT external_id AS awork_time_booking_id,
       external_person_id AS awork_user_id,
       external_project_id AS awork_project_id,
       start_date,
       end_date,
       duration_seconds,
       (extra ->> 'lane_order')::integer AS lane_order,
       description,
       source_created_at AS created_on,
       source_updated_at AS updated_on,
       last_seen_sync_run_id
FROM planned_booking
WHERE integration_slug = 'awork';
--> statement-breakpoint
CREATE VIEW "awork_user" AS
SELECT external_id AS awork_user_id,
       first_name,
       last_name,
       email,
       extra ->> 'position' AS position,
       extra ->> 'title' AS title,
       (extra ->> 'is_agent')::boolean AS is_agent,
       (extra ->> 'is_archived')::boolean AS is_archived,
       (extra ->> 'is_deactivated')::boolean AS is_deactivated,
       is_external,
       status,
       (extra ->> 'created_on')::timestamp AS created_on,
       last_seen_sync_run_id,
       last_updated_at
FROM external_person
WHERE integration_slug = 'awork';
--> statement-breakpoint
CREATE VIEW "awork_company" AS
SELECT external_id AS awork_company_id,
       name,
       is_external,
       (extra ->> 'projects_count')::integer AS projects_count,
       (extra ->> 'projects_in_progress_count')::integer AS projects_in_progress_count,
       (extra ->> 'created_on')::timestamp AS created_on,
       source_updated_at AS updated_on,
       last_seen_sync_run_id,
       last_updated_at
FROM external_company
WHERE integration_slug = 'awork';
--> statement-breakpoint
CREATE VIEW "awork_project" AS
SELECT external_id AS awork_project_id,
       name,
       project_key,
       external_company_id AS awork_company_id,
       billable AS is_billable_by_default,
       (extra ->> 'is_external')::boolean AS is_external,
       (extra ->> 'is_private')::boolean AS is_private,
       (extra ->> 'is_retainer')::boolean AS is_retainer,
       extra ->> 'project_status_id' AS project_status_id,
       description,
       (extra ->> 'tasks_count')::integer AS tasks_count,
       (extra ->> 'tasks_done_count')::integer AS tasks_done_count,
       (extra ->> 'created_on')::timestamp AS created_on,
       source_updated_at AS updated_on,
       last_seen_sync_run_id,
       last_updated_at,
       start_date,
       due_date,
       closed_on,
       time_budget_seconds,
       status_type AS project_status_type,
       status_name AS project_status_name,
       (extra ->> 'daily_rate_eur')::numeric(12, 2) AS daily_rate_eur,
       (extra ->> 'fixed_price_eur')::numeric(12, 2) AS fixed_price_eur,
       extra ->> 'order_number' AS order_number
FROM external_project
WHERE integration_slug = 'awork';
--> statement-breakpoint
CREATE VIEW "personio_project" AS
SELECT external_id AS personio_project_id,
       COALESCE(name, '') AS name,
       active,
       last_seen_sync_run_id,
       last_updated_at,
       billable,
       parent_external_id AS parent_id
FROM external_project
WHERE integration_slug = 'personio';
--> statement-breakpoint
CREATE VIEW "personio_project_link" AS
SELECT external_id AS personio_project_id, dante_id AS project_id, mapped_at
FROM external_link
WHERE integration_slug = 'personio' AND entity_type = 'project';
--> statement-breakpoint
CREATE VIEW "awork_project_link" AS
SELECT external_id AS awork_project_id, dante_id AS project_id, mapped_at
FROM external_link
WHERE integration_slug = 'awork' AND entity_type = 'project';
--> statement-breakpoint
CREATE VIEW "awork_user_link" AS
SELECT external_id AS awork_user_id, dante_id AS employee_id, mapped_at
FROM external_link
WHERE integration_slug = 'awork' AND entity_type = 'person' AND dante_type = 'employee';
--> statement-breakpoint
CREATE VIEW "awork_freelancer_link" AS
SELECT external_id AS awork_user_id, dante_id AS freelancer_id, mapped_at
FROM external_link
WHERE integration_slug = 'awork' AND entity_type = 'person' AND dante_type = 'freelancer';
--> statement-breakpoint
CREATE VIEW "awork_company_link" AS
SELECT external_id AS awork_company_id, dante_id AS customer_id, mapped_at
FROM external_link
WHERE integration_slug = 'awork' AND entity_type = 'company';
--> statement-breakpoint
-- Verbatim 0022 definition, now over the compatibility views.
CREATE VIEW "tracked_time_effective" AS
SELECT a.employee_id,
       a.work_date,
       CASE
         WHEN a.project_id IS NULL THEN 'untagged'
         WHEN pl.project_id IS NOT NULL
           THEN CASE WHEN pp_proj.billable THEN 'billable' ELSE 'non_billable' END
         ELSE CASE WHEN COALESCE(pp.billable, TRUE) THEN 'billable' ELSE 'non_billable' END
       END AS bucket,
       a.duration_minutes,
       'personio'::text AS source
FROM attendance a
LEFT JOIN personio_project_link pl ON pl.personio_project_id = a.project_id
LEFT JOIN project pp_proj ON pp_proj.project_id = pl.project_id
LEFT JOIN personio_project pp ON pp.personio_project_id = a.project_id
WHERE NOT EXISTS (
  SELECT 1
  FROM awork_time_entry t2
  JOIN awork_user_link ul2 ON ul2.awork_user_id = t2.awork_user_id
  WHERE ul2.employee_id = a.employee_id AND t2.work_date = a.work_date
)
UNION ALL
SELECT ul.employee_id,
       t.work_date,
       CASE
         WHEN apl.project_id IS NOT NULL
           THEN CASE WHEN ap_proj.billable THEN 'billable' ELSE 'non_billable' END
         ELSE CASE WHEN COALESCE(ap.is_billable_by_default, TRUE) THEN 'billable' ELSE 'non_billable' END
       END AS bucket,
       t.duration_minutes,
       'awork'::text AS source
FROM awork_time_entry t
JOIN awork_user_link ul ON ul.awork_user_id = t.awork_user_id
LEFT JOIN awork_project_link apl ON apl.awork_project_id = t.awork_project_id
LEFT JOIN project ap_proj ON ap_proj.project_id = apl.project_id
LEFT JOIN awork_project ap ON ap.awork_project_id = t.awork_project_id;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. external_link follows its Dante entity
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION external_link_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM external_link
	 WHERE dante_type = TG_ARGV[0]
	   AND dante_id = (to_jsonb(OLD) ->> TG_ARGV[1])::integer;
	RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "project_external_link_cascade"
	AFTER DELETE ON "project"
	FOR EACH ROW EXECUTE FUNCTION external_link_cascade('project', 'project_id');
--> statement-breakpoint
CREATE TRIGGER "customer_external_link_cascade"
	AFTER DELETE ON "customer"
	FOR EACH ROW EXECUTE FUNCTION external_link_cascade('customer', 'customer_id');
--> statement-breakpoint
CREATE TRIGGER "freelancer_external_link_cascade"
	AFTER DELETE ON "freelancer"
	FOR EACH ROW EXECUTE FUNCTION external_link_cascade('freelancer', 'freelancer_id');
--> statement-breakpoint
CREATE TRIGGER "employee_current_external_link_cascade"
	AFTER DELETE ON "employee_current"
	FOR EACH ROW EXECUTE FUNCTION external_link_cascade('employee', 'employee_id');
