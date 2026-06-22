-- Seed the `burden_factor` setting so prod (and any new env) has a
-- value the moment it boots, instead of falling back to the hardcoded
-- defaults scattered across the codebase (1.0 in `assignment.ts`, 1.3
-- in `_monthly-helpers.ts`). The /settings UI dynamically renders
-- every row in the `setting` table, so this also makes the field
-- visible + editable.

INSERT INTO setting (key, value, description, updated_at)
VALUES (
  'burden_factor',
  '1.3',
  'Multiplier applied to gross salary to get fully-loaded monthly cost. Covers employer-side overhead (social charges, equipment, office, etc.). Edit here to recompute every margin / portfolio view on the next page load — there is no cache to bust.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
