-- Billability model. Two new columns:
--
--   1. `personio_project.billable` (nullable) — the Personio v2 per-project
--      `billable` flag, synced going forward. Source of truth for UNLINKED
--      Personio projects; seeds the Dante project on link for LINKED ones.
--
--   2. `project.billable` (NOT NULL, default true) — Dante-owned billability
--      for tracked time on a project. Default true; auto-seeded false when a
--      linked source project (Personio/awork) is non-billable; overridable by
--      manager/admin/SDM. Existing projects default to billable (the common
--      case) — the awork/Personio seeding + manual override correct the rest.

ALTER TABLE "personio_project" ADD COLUMN "billable" boolean;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "billable" boolean NOT NULL DEFAULT true;
