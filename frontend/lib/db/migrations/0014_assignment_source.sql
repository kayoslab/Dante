-- Mark assignment rows by their provenance so sync passes can refresh
-- their own rows without touching manually-curated ones.
--
-- Values today:
--   'manual'         — SDM/PM entered via the UI (default)
--   'awork-planning' — synthesized from awork_time_booking on every
--                      sync (Planner = source of truth, full refresh)
--
-- The 22 surviving rows from before this column existed were all
-- manual — the old `[awork-derived]` rows got deleted in the cleanup
-- pass that introduced this migration.
ALTER TABLE "assignment"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
--> statement-breakpoint

-- Sync's first action each run is `DELETE … WHERE source = 'awork-planning'`,
-- so the index keeps that wipe fast even when the table grows.
CREATE INDEX "assignment_source_idx" ON "assignment" ("source");
