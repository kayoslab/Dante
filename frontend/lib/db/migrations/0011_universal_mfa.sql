-- MFA is now mandatory for every user, not just admin / manager.
-- The `mfa_required` flag is therefore redundant — the gate becomes
-- "do you have `mfa_enrolled_at` set?" plus the per-session
-- `mfa_verified` bit. Drop the column; the existing `mfa_enrolled_at`
-- column stays and is the new source of truth.
ALTER TABLE "app_user" DROP COLUMN "mfa_required";
