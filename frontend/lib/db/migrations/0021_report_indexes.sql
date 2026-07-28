-- Report-path indexes. The hottest report tables had none: attendance and
-- awork_time_entry (the largest, daily-growing tables — scanned by every
-- tracked-hours / utilization / rentability computation), assignment (only
-- had a `source` index), absence, and compensation_event. Every per-employee
-- lookup in the report engines was a sequential scan, so report latency
-- degraded linearly with data growth.

CREATE INDEX IF NOT EXISTS "attendance_employee_date_idx" ON "attendance" ("employee_id","work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_date_idx" ON "attendance" ("work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_project_idx" ON "attendance" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "awork_time_entry_user_date_idx" ON "awork_time_entry" ("awork_user_id","work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "awork_time_entry_date_idx" ON "awork_time_entry" ("work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "awork_time_entry_project_idx" ON "awork_time_entry" ("awork_project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "absence_employee_dates_idx" ON "absence" ("employee_id","start_date","end_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_employee_idx" ON "assignment" ("employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_project_idx" ON "assignment" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compensation_event_employee_from_idx" ON "compensation_event" ("employee_id","effective_from");
