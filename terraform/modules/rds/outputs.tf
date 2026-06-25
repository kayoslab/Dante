output "instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "RDS instance ARN. Pass into the GitHub OIDC deploy role's `rds_db_instance_arns` so terraform apply can flip `iam_database_authentication_enabled` and similar in-place modifications. Distinct from `iam_app_user_arn` (rds-db:connect grant for the runtime); this one is for `rds:ModifyDBInstance` from CI."
  value       = aws_db_instance.this.arn
}

output "endpoint" {
  description = "RDS endpoint hostname:port. The app composes DATABASE_URL from the managed secret rather than reading this directly, but exposed for ad-hoc tooling (e.g. psql via a bastion)."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "RDS endpoint hostname (no port). Used by health checks and DNS aliases."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "RDS port. Always 5432 for Postgres but exposed for completeness."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Bootstrap database name."
  value       = aws_db_instance.this.db_name
}

output "master_user_secret_arn" {
  description = "ARN of the Secrets Manager secret RDS rotates the master credential into. Pass this to the app + sync Lambda so they can compose DATABASE_URL at boot. Secret JSON shape: { username, password }."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "master_user_secret_kms_key_id" {
  description = "KMS key the master secret is encrypted with. Useful for IAM policies that grant kms:Decrypt to the reading principal."
  value       = aws_db_instance.this.master_user_secret[0].kms_key_id
}

output "security_group_id" {
  description = "SG attached to the RDS instance. Reference from app SGs as an ingress source if you want to gate access by SG instead of by passing them in here."
  value       = aws_security_group.rds.id
}

output "resource_id" {
  description = "RDS-generated immutable resource identifier (`db-XXXXX`). Used in `rds-db:connect` IAM ARNs (`arn:aws:rds-db:<region>:<account>:dbuser:<resource_id>/<dbuser>`). Distinct from `instance_id` — instance_id is the human-readable name and can be changed; resource_id is permanent for the instance's lifetime."
  value       = aws_db_instance.this.resource_id
}

output "app_username" {
  description = "Non-master DB user the app + sync runtime authenticate as via IAM auth. Pass into ECS / Lambda env as DANTE_APP_DB_USERNAME."
  value       = var.app_username
}

output "iam_app_user_arn" {
  description = "Fully-qualified rds-db:connect ARN for the app user. Pass into the ECS task role and sync Lambda role IAM policies via `rds_iam_db_user_arns = [...]`."
  value       = "arn:aws:rds-db:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.this.resource_id}/${var.app_username}"
}
