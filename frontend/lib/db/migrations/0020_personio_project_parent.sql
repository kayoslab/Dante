-- Personio v2 subprojects. Each Personio project may set `parent_project.id`
-- (a subproject of another project); top-level projects leave it null. Stored
-- as a plain nullable text self-reference — no FK, so a child synced before
-- its parent row exists can't fail on a constraint. The link picker resolves
-- the parent name via a self-join and renders the parent → child hierarchy.

ALTER TABLE "personio_project" ADD COLUMN "parent_id" text;
