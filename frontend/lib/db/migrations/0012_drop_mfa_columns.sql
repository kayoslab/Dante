-- MFA moved to Cognito (TOTP + WebAuthn passkeys via the hosted UI).
-- The in-app TOTP layer that owned these columns is gone; the user pool
-- enforces `mfa_configuration = "ON"` so by the time we see an OIDC
-- token, MFA has already happened. No more app-side secret to store.
ALTER TABLE "app_user" DROP COLUMN "mfa_secret";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "mfa_enrolled_at";
