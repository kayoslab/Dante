-- Integration model — phase 3 of docs/integration-adapters.md.
--
-- `integration_secret` backs the database flavour of the secret store
-- (lib/integrations/core/secret-store.ts): one row per (integration,
-- document kind), AES-256-GCM under DANTE_SECRET_KEY. Deployments on
-- Secrets Manager never write here. Ciphertext, iv and tag are base64.
CREATE TABLE "integration_secret" (
	"integration_slug" text NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_secret_integration_slug_kind_pk" PRIMARY KEY ("integration_slug", "kind"),
	CONSTRAINT "integration_secret_kind_chk" CHECK ("kind" IN ('credentials', 'tokens'))
);
--> statement-breakpoint
ALTER TABLE "integration_secret"
	ADD CONSTRAINT "integration_secret_integration_slug_integration_slug_fk"
	FOREIGN KEY ("integration_slug") REFERENCES "public"."integration"("slug")
	ON DELETE cascade ON UPDATE no action;
