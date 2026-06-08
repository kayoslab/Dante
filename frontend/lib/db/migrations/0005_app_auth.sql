CREATE TABLE "app_audit_log" (
	"audit_id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"ip_address" text,
	"user_agent" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text NOT NULL,
	"email" text NOT NULL,
	"employee_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "app_audit_log" ADD CONSTRAINT "app_audit_log_user_id_app_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_employee_id_employee_current_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee_current"("employee_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_audit_user_at_idx" ON "app_audit_log" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "app_audit_action_at_idx" ON "app_audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_cognito_sub_idx" ON "app_user" USING btree ("cognito_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_idx" ON "app_user" USING btree (LOWER("email"));--> statement-breakpoint
CREATE INDEX "app_user_employee_idx" ON "app_user" USING btree ("employee_id");