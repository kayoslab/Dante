output "instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.identifier
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
