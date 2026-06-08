ALTER TABLE "app_user" ADD COLUMN "role" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "is_disabled" boolean DEFAULT false NOT NULL;