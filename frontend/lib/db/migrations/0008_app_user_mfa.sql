ALTER TABLE "app_user" ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "mfa_enrolled_at" timestamp;--> statement-breakpoint

-- Default admin + manager to MFA-required. Existing employee users keep
-- the default `false`; they can opt-in via /profile if they want.
UPDATE "app_user"
SET "mfa_required" = true
WHERE "role" IN ('admin', 'manager');
