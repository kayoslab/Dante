/**
 * Secrets module — creates the KMS key and the empty Secrets Manager
 * secret containers that the sync layer reads from. Values are written
 * by `scripts/seed-secrets.ts` (dev) or by the admin out-of-band (prod);
 * Terraform owns the *shape* (key, IAM, rotation policy), not the data.
 *
 * Secret names follow the `dante/<env>/<key>` convention that
 * `lib/sync/credentials.ts` expects. Changing one means changing the
 * other.
 */

locals {
  prefix = "${var.name_prefix}/${var.environment}"
}

resource "aws_kms_key" "secrets" {
  count = var.create_kms_key ? 1 : 0

  description             = "${var.name_prefix} ${var.environment} — Secrets Manager encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "secrets" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${var.name_prefix}-${var.environment}-secrets"
  target_key_id = aws_kms_key.secrets[0].id
}

# Personio API client — required.
resource "aws_secretsmanager_secret" "personio" {
  name                    = "${local.prefix}/personio"
  description             = "Personio OAuth client_id + client_secret"
  kms_key_id              = try(aws_kms_key.secrets[0].arn, null)
  recovery_window_in_days = var.recovery_window_in_days
}

# awork OAuth client — optional (awork integration is Phase B).
resource "aws_secretsmanager_secret" "awork_client" {
  name                    = "${local.prefix}/awork/client"
  description             = "awork OAuth client_id (+ optional client_secret)"
  kms_key_id              = try(aws_kms_key.secrets[0].arn, null)
  recovery_window_in_days = var.recovery_window_in_days
}

# awork rotating tokens — written on every sync.
resource "aws_secretsmanager_secret" "awork_tokens" {
  name                    = "${local.prefix}/awork/tokens"
  description             = "awork access_token, refresh_token, expires_at — rotated on every sync"
  kms_key_id              = try(aws_kms_key.secrets[0].arn, null)
  recovery_window_in_days = var.recovery_window_in_days
}

# Auth.js JWT signing key. Operator writes the value out-of-band after
# the first apply: `openssl rand -base64 64` → put-secret-value.
# The ECS task definition reads this as the `AUTH_SECRET` env var.
resource "aws_secretsmanager_secret" "auth_secret" {
  name                    = "${local.prefix}/auth_secret"
  description             = "Auth.js JWT signing key (HS256). Rotation invalidates all active sessions."
  kms_key_id              = try(aws_kms_key.secrets[0].arn, null)
  recovery_window_in_days = var.recovery_window_in_days
}

# Cognito user-pool client secret. Unlike the other secrets in this
# module, terraform owns BOTH the shape and the value: the cognito
# module generates the secret as a sensitive output, and the env's
# `module.secrets` call wires it straight in. Keeping it in Secrets
# Manager (rather than the task def's plaintext environment block)
# means a `DescribeTaskDefinition` call no longer leaks the value.
resource "aws_secretsmanager_secret" "cognito_client_secret" {
  name                    = "${local.prefix}/cognito_client_secret"
  description             = "Cognito user-pool client secret — populated by terraform from module.cognito.client_secret."
  kms_key_id              = try(aws_kms_key.secrets[0].arn, null)
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "cognito_client_secret" {
  count         = var.cognito_client_secret == null ? 0 : 1
  secret_id     = aws_secretsmanager_secret.cognito_client_secret.id
  secret_string = var.cognito_client_secret
}
