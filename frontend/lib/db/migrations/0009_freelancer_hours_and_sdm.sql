-- Freelancer monthly time entries. One row per (assignment, year_month).
--
-- The assignment FK is to any assignment row; the action layer enforces
-- that `freelancer_id IS NOT NULL` on the linked assignment (CHECK can't
-- look at another table). `source` distinguishes manual SDM entry from
-- the awork sync; manual wins on conflict (see syncAworkTimeEntries).
CREATE TABLE "freelancer_time_entry" (
  "assignment_id" integer NOT NULL REFERENCES "assignment"("assignment_id") ON DELETE CASCADE,
  "year_month" varchar(7) NOT NULL,
  "hours_decimal" numeric(8, 2) NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "entered_by" uuid REFERENCES "app_user"("user_id") ON DELETE SET NULL,
  "entered_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "freelancer_time_entry_pk" PRIMARY KEY ("assignment_id", "year_month"),
  CONSTRAINT "freelancer_time_entry_year_month_chk"
    CHECK ("year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "freelancer_time_entry_hours_nonneg_chk"
    CHECK ("hours_decimal" >= 0),
  CONSTRAINT "freelancer_time_entry_source_chk"
    CHECK ("source" IN ('manual', 'awork'))
);
--> statement-breakpoint

CREATE INDEX "freelancer_time_entry_month_idx"
  ON "freelancer_time_entry" ("year_month");
--> statement-breakpoint

-- Per-project SDM (Service Delivery Manager) capability grant.
--
-- An app_user with `role = 'employee'` who has at least one row here is
-- treated as a manager for those project_ids (see canManageProject).
-- Admin/manager users don't need rows here; they short-circuit the check.
CREATE TABLE "project_sdm" (
  "project_id" integer NOT NULL REFERENCES "project"("project_id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "app_user"("user_id") ON DELETE CASCADE,
  "granted_at" timestamp NOT NULL DEFAULT now(),
  "granted_by" uuid REFERENCES "app_user"("user_id") ON DELETE SET NULL,
  CONSTRAINT "project_sdm_pk" PRIMARY KEY ("project_id", "user_id")
);
--> statement-breakpoint

-- "What can this SDM access?" is the hot lookup (Home dashboard).
CREATE INDEX "project_sdm_user_idx" ON "project_sdm" ("user_id");
