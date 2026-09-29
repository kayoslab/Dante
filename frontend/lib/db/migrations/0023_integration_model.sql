-- Integration model — phase 1 of docs/integration-adapters.md.
--
-- Additive and behaviour-neutral. The existing Personio / awork sync and
-- every report keep working unchanged; this migration only introduces the
-- provider-agnostic objects the phase-2 adapters will write to, seeds them
-- with today's implicit configuration, and starts keeping `external_link`
-- consistent with the five legacy link tables.
--
-- 1. `integration`, `integration_binding`, `integration_rule` — the admin-
--    configurable model: which connector exists, which capability it feeds
--    (in priority order), and the per-capability policies (overlap
--    reconciliation, auto-link, import). Seeded to mirror the hard-coded
--    behaviour of `lib/sync/run.ts` so nothing changes when the runner
--    starts reading them.
-- 2. `external_link` — one generic (integration, entity, external id) →
--    (Dante entity) mapping, backfilled from personio_project_link,
--    awork_project_link, awork_user_link, awork_freelancer_link,
--    awork_company_link, plus one ('personio','person') row per employee.
--    Row-level triggers on the legacy tables mirror every insert / update /
--    delete into external_link until phase 2 retires them. FK cascades
--    (project delete → link delete) fire the row triggers too.
-- 3. `employee_current.employee_id` becomes a Dante-owned identity. Values
--    are untouched; the sequence starts above the current maximum so a
--    second HRIS can mint ids without colliding. The Personio sync bumps
--    the sequence after each upsert (lib/sync/personio/employees.ts).
-- 4. Canonical landing tables — external_person, external_company,
--    external_project, time_entry, planned_booking. Empty until phase 2;
--    absence and compensation_event are reshaped in place in phase 2 when
--    their writer moves, because the current sync cannot fill the new
--    columns.

-- ---------------------------------------------------------------------------
-- 1. Integration registry, bindings, rules
-- ---------------------------------------------------------------------------
CREATE TABLE "integration" (
	"slug" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_state" text DEFAULT 'missing' NOT NULL,
	"credential_set_at" timestamp,
	"credential_set_by" text,
	"last_sync_at" timestamp,
	"last_sync_status" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_credential_state_chk"
		CHECK ("credential_state" IN ('missing', 'set', 'invalid', 'external'))
);
--> statement-breakpoint
CREATE TABLE "integration_binding" (
	"capability" text NOT NULL,
	"integration_slug" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "integration_binding_capability_integration_slug_pk"
		PRIMARY KEY ("capability", "integration_slug"),
	CONSTRAINT "uq_integration_binding_priority" UNIQUE ("capability", "priority"),
	CONSTRAINT "integration_binding_capability_chk" CHECK ("capability" IN (
		'people', 'external_contributors', 'companies', 'projects',
		'absences', 'compensations', 'time_entries', 'planned_bookings'
	))
);
--> statement-breakpoint
ALTER TABLE "integration_binding"
	ADD CONSTRAINT "integration_binding_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "integration_rule" (
	"capability" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_rule_capability_key_pk" PRIMARY KEY ("capability", "key")
);
--> statement-breakpoint
-- Today's two connectors. Credentials are still env / Secrets Manager
-- managed ('external') until phase 3 adds the write-only UI.
INSERT INTO "integration" ("slug", "provider", "display_name", "enabled", "credential_state")
VALUES
	('personio', 'personio', 'Personio', true, 'external'),
	('awork', 'awork', 'awork', true, 'external');
--> statement-breakpoint
-- Bindings mirror lib/sync/run.ts: Personio is the HRIS (people, absences,
-- compensations), awork is the delivery tool (companies, projects, planner,
-- freelancers). Both feed tracked time and both expose a project list;
-- awork is primary for each because the day-level reconciliation and the
-- project import prefer it.
INSERT INTO "integration_binding" ("capability", "integration_slug", "priority")
VALUES
	('people',                'personio', 0),
	('absences',              'personio', 0),
	('compensations',         'personio', 0),
	('external_contributors', 'awork',    0),
	('companies',             'awork',    0),
	('projects',              'awork',    0),
	('projects',              'personio', 1),
	('time_entries',          'awork',    0),
	('time_entries',          'personio', 1),
	('planned_bookings',      'awork',    0);
--> statement-breakpoint
-- Rules mirror the policies currently hard-coded in SQL and in
-- lib/sync/awork/sync.ts + housekeeping.ts:
--   time_entries.overlap_policy — for any (person, day) with awork time the
--     Personio attendance of that day is dropped (tracked-hours dedup).
--   people / external_contributors.auto_link_email — awork users auto-link
--     to employees / freelancers by e-mail.
--   companies.auto_link_name — awork companies auto-link to customers by
--     case-insensitive name.
--   projects.import_policy — bulkImportFromAwork / applyAworkMoneyToImported
--     / backfillImportedProjects.
INSERT INTO "integration_rule" ("capability", "key", "value")
VALUES
	('time_entries',          'overlap_policy',  '{"kind": "day_wins", "integration": "awork"}'),
	('people',                'auto_link_email', '{"integrations": ["awork"]}'),
	('external_contributors', 'auto_link_email', '{"integrations": ["awork"]}'),
	('companies',             'auto_link_name',  '{"integrations": ["awork"]}'),
	('projects',              'import_policy',   '{"integration": "awork", "customers": true, "projects": true, "apply_money": true, "refresh_dates": true}');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. external_link + backfill + legacy mirror triggers
-- ---------------------------------------------------------------------------
CREATE TABLE "external_link" (
	"integration_slug" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"dante_type" text NOT NULL,
	"dante_id" integer NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"mapped_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_link_integration_slug_entity_type_external_id_pk"
		PRIMARY KEY ("integration_slug", "entity_type", "external_id"),
	CONSTRAINT "external_link_entity_type_chk"
		CHECK ("entity_type" IN ('person', 'project', 'company')),
	CONSTRAINT "external_link_target_chk" CHECK (
		("entity_type" = 'person'  AND "dante_type" IN ('employee', 'freelancer')) OR
		("entity_type" = 'project' AND "dante_type" = 'project') OR
		("entity_type" = 'company' AND "dante_type" = 'customer')
	)
);
--> statement-breakpoint
ALTER TABLE "external_link"
	ADD CONSTRAINT "external_link_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "external_link_dante_idx" ON "external_link" USING btree ("dante_type", "dante_id");
--> statement-breakpoint
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'personio', 'person', employee_id::text, 'employee', employee_id, 'backfill', last_updated_at
FROM employee_current;
--> statement-breakpoint
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'personio', 'project', personio_project_id, 'project', project_id, 'backfill', mapped_at
FROM personio_project_link;
--> statement-breakpoint
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'awork', 'project', awork_project_id, 'project', project_id, 'backfill', mapped_at
FROM awork_project_link;
--> statement-breakpoint
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'awork', 'person', awork_user_id, 'employee', employee_id, 'backfill', mapped_at
FROM awork_user_link;
--> statement-breakpoint
-- An awork user is an employee XOR a freelancer by construction; the
-- ON CONFLICT is a belt-and-braces guard so a stray double entry can't
-- abort the migration (the employee link wins).
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'awork', 'person', awork_user_id, 'freelancer', freelancer_id, 'backfill', mapped_at
FROM awork_freelancer_link
ON CONFLICT ("integration_slug", "entity_type", "external_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "external_link" ("integration_slug", "entity_type", "external_id", "dante_type", "dante_id", "origin", "mapped_at")
SELECT 'awork', 'company', awork_company_id, 'customer', customer_id, 'backfill', mapped_at
FROM awork_company_link;
--> statement-breakpoint
-- Generic mirror: one trigger function, parametrised per legacy table with
-- (integration slug, entity type, external-id column, dante type, dante-id
-- column). Column access goes through to_jsonb so the same function serves
-- all six tables. Removed in phase 2 together with the legacy tables.
CREATE OR REPLACE FUNCTION external_link_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_slug       text := TG_ARGV[0];
	v_entity     text := TG_ARGV[1];
	v_ext_col    text := TG_ARGV[2];
	v_dante_type text := TG_ARGV[3];
	v_dante_col  text := TG_ARGV[4];
	v_new        jsonb;
	v_old        jsonb;
	v_ext_id     text;
	v_old_ext_id text;
	v_dante_id   integer;
	v_mapped_at  timestamp;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_old := to_jsonb(OLD);
		DELETE FROM external_link
		 WHERE integration_slug = v_slug
		   AND entity_type = v_entity
		   AND external_id = v_old ->> v_ext_col
		   AND dante_type = v_dante_type;
		RETURN OLD;
	END IF;

	v_new := to_jsonb(NEW);
	v_ext_id := v_new ->> v_ext_col;
	v_dante_id := (v_new ->> v_dante_col)::integer;
	v_mapped_at := COALESCE((v_new ->> 'mapped_at')::timestamp, now());

	IF TG_OP = 'UPDATE' THEN
		v_old := to_jsonb(OLD);
		v_old_ext_id := v_old ->> v_ext_col;
		IF v_old_ext_id IS DISTINCT FROM v_ext_id THEN
			DELETE FROM external_link
			 WHERE integration_slug = v_slug
			   AND entity_type = v_entity
			   AND external_id = v_old_ext_id
			   AND dante_type = v_dante_type;
		END IF;
	END IF;

	INSERT INTO external_link
		(integration_slug, entity_type, external_id, dante_type, dante_id, origin, mapped_at)
	VALUES
		(v_slug, v_entity, v_ext_id, v_dante_type, v_dante_id, 'legacy', v_mapped_at)
	ON CONFLICT (integration_slug, entity_type, external_id) DO UPDATE
	   SET dante_type = EXCLUDED.dante_type,
	       dante_id   = EXCLUDED.dante_id,
	       mapped_at  = EXCLUDED.mapped_at;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "personio_project_link_mirror"
	AFTER INSERT OR UPDATE OR DELETE ON "personio_project_link"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('personio', 'project', 'personio_project_id', 'project', 'project_id');
--> statement-breakpoint
CREATE TRIGGER "awork_project_link_mirror"
	AFTER INSERT OR UPDATE OR DELETE ON "awork_project_link"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('awork', 'project', 'awork_project_id', 'project', 'project_id');
--> statement-breakpoint
CREATE TRIGGER "awork_user_link_mirror"
	AFTER INSERT OR UPDATE OR DELETE ON "awork_user_link"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('awork', 'person', 'awork_user_id', 'employee', 'employee_id');
--> statement-breakpoint
CREATE TRIGGER "awork_freelancer_link_mirror"
	AFTER INSERT OR UPDATE OR DELETE ON "awork_freelancer_link"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('awork', 'person', 'awork_user_id', 'freelancer', 'freelancer_id');
--> statement-breakpoint
CREATE TRIGGER "awork_company_link_mirror"
	AFTER INSERT OR UPDATE OR DELETE ON "awork_company_link"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('awork', 'company', 'awork_company_id', 'customer', 'customer_id');
--> statement-breakpoint
-- Every employee the Personio sync inserts is, by definition, a Personio
-- person with the same id. Keeps the ('personio','person') links complete
-- until phase 2 makes the runner responsible. INSERT only: updates never
-- change employee_id and rows are never deleted by the sync.
CREATE TRIGGER "employee_current_personio_link_mirror"
	AFTER INSERT ON "employee_current"
	FOR EACH ROW EXECUTE FUNCTION external_link_mirror('personio', 'person', 'employee_id', 'employee', 'employee_id');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. employee_current.employee_id → Dante-owned identity
-- ---------------------------------------------------------------------------
ALTER TABLE "employee_current"
	ALTER COLUMN "employee_id" ADD GENERATED BY DEFAULT AS IDENTITY;
--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('employee_current', 'employee_id'),
	COALESCE((SELECT MAX(employee_id) FROM employee_current), 0) + 1,
	false
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Canonical landing tables (empty until phase 2)
-- ---------------------------------------------------------------------------
CREATE TABLE "external_person" (
	"integration_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"status" text,
	"is_active" boolean,
	"is_external" boolean,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_updated_at" timestamp,
	"last_seen_sync_run_id" integer,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_person_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id")
);
--> statement-breakpoint
ALTER TABLE "external_person"
	ADD CONSTRAINT "external_person_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "external_person_email_idx" ON "external_person" USING btree ("email");
--> statement-breakpoint
CREATE TABLE "external_company" (
	"integration_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"is_external" boolean,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_updated_at" timestamp,
	"last_seen_sync_run_id" integer,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_company_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id")
);
--> statement-breakpoint
ALTER TABLE "external_company"
	ADD CONSTRAINT "external_company_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "external_company_name_idx" ON "external_company" USING btree ("name");
--> statement-breakpoint
CREATE TABLE "external_project" (
	"integration_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"project_key" text,
	"external_company_id" text,
	"parent_external_id" text,
	"billable" boolean,
	"active" boolean,
	"status_type" text,
	"status_name" text,
	"start_date" date,
	"due_date" date,
	"closed_on" date,
	"time_budget_seconds" bigint,
	"description" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_updated_at" timestamp,
	"last_seen_sync_run_id" integer,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_project_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id")
);
--> statement-breakpoint
ALTER TABLE "external_project"
	ADD CONSTRAINT "external_project_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "external_project_company_idx" ON "external_project" USING btree ("integration_slug", "external_company_id");
--> statement-breakpoint
CREATE TABLE "time_entry" (
	"integration_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"external_person_id" text NOT NULL,
	"external_project_id" text,
	"external_task_id" text,
	"work_date" date NOT NULL,
	"start_at" timestamp,
	"end_at" timestamp,
	"duration_minutes" integer NOT NULL,
	"is_billable" boolean,
	"is_billed" boolean,
	"status" text,
	"note" text,
	"type_of_work" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_updated_at" timestamp,
	"last_seen_sync_run_id" integer NOT NULL,
	CONSTRAINT "time_entry_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id")
);
--> statement-breakpoint
ALTER TABLE "time_entry"
	ADD CONSTRAINT "time_entry_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "time_entry_person_date_idx" ON "time_entry" USING btree ("integration_slug", "external_person_id", "work_date");
--> statement-breakpoint
CREATE INDEX "time_entry_date_idx" ON "time_entry" USING btree ("work_date");
--> statement-breakpoint
CREATE INDEX "time_entry_project_idx" ON "time_entry" USING btree ("integration_slug", "external_project_id");
--> statement-breakpoint
CREATE TABLE "planned_booking" (
	"integration_slug" text NOT NULL,
	"external_id" text NOT NULL,
	"external_person_id" text NOT NULL,
	"external_project_id" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"duration_seconds" integer NOT NULL,
	"description" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_created_at" timestamp,
	"source_updated_at" timestamp,
	"last_seen_sync_run_id" integer NOT NULL,
	CONSTRAINT "planned_booking_integration_slug_external_id_pk" PRIMARY KEY ("integration_slug", "external_id")
);
--> statement-breakpoint
ALTER TABLE "planned_booking"
	ADD CONSTRAINT "planned_booking_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "planned_booking_person_window_idx" ON "planned_booking" USING btree ("integration_slug", "external_person_id", "start_date", "end_date");
