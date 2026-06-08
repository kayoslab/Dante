output "kms_key_arn" {
  description = "ARN of the customer-managed key, or null when create_kms_key=false."
  value       = try(aws_kms_key.secrets[0].arn, null)
}

output "kms_key_alias" {
  description = "Alias name of the customer-managed key, or null when create_kms_key=false."
  value       = try(aws_kms_alias.secrets[0].name, null)
}

output "personio_secret_arn" {
  description = "ARN of the Personio credentials secret."
  value       = aws_secretsmanager_secret.personio.arn
}

output "awork_client_secret_arn" {
  description = "ARN of the awork OAuth client credentials secret."
  value       = aws_secretsmanager_secret.awork_client.arn
}

output "awork_tokens_secret_arn" {
  description = "ARN of the awork rotating tokens secret."
  value       = aws_secretsmanager_secret.awork_tokens.arn
}

output "auth_secret_arn" {
  description = "ARN of the Auth.js JWT signing key secret. Pass into the ECS task definition's `secrets:` block as `AUTH_SECRET`."
  value       = aws_secretsmanager_secret.auth_secret.arn
}

output "all_secret_arns" {
  description = "All secret ARNs, for IAM policy generation in dependent modules (ECS task role, Lambda execution role)."
  value = [
    aws_secretsmanager_secret.personio.arn,
    aws_secretsmanager_secret.awork_client.arn,
    aws_secretsmanager_secret.awork_tokens.arn,
    aws_secretsmanager_secret.auth_secret.arn,
  ]
}
