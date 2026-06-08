-- Convert employee_current.absence_entitlement + raw_employee_snapshot.payload
-- from text (where they held JSON-as-string) to native jsonb. USING clause
-- casts the existing text → jsonb in place.

ALTER TABLE "employee_current"
  ALTER COLUMN "absence_entitlement" SET DATA TYPE jsonb
  USING "absence_entitlement"::jsonb;
--> statement-breakpoint
ALTER TABLE "raw_employee_snapshot"
  ALTER COLUMN "payload" SET DATA TYPE jsonb
  USING "payload"::jsonb;
