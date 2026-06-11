-- awork users → Dante freelancers.
--
-- Mirrors `awork_user_link` (awork → employee) but points at the
-- freelancer table. Freelancers in awork have full agent accounts; the
-- auto-linker matches awork_user.email → freelancer.contact_email
-- (case-insensitive). Manual linking via /settings/integrations/awork
-- handles the rest.
CREATE TABLE "awork_freelancer_link" (
  "awork_user_id" text PRIMARY KEY REFERENCES "awork_user"("awork_user_id") ON DELETE CASCADE,
  "freelancer_id" integer NOT NULL REFERENCES "freelancer"("freelancer_id") ON DELETE CASCADE,
  "mapped_at" timestamp NOT NULL
);
--> statement-breakpoint

CREATE INDEX "awork_freelancer_link_freelancer_idx"
  ON "awork_freelancer_link" ("freelancer_id");
