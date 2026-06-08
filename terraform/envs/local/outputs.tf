output "kms_key_arn" {
  value = module.secrets.kms_key_arn
}

output "personio_secret_arn" {
  value = module.secrets.personio_secret_arn
}

output "awork_client_secret_arn" {
  value = module.secrets.awork_client_secret_arn
}

output "awork_tokens_secret_arn" {
  value = module.secrets.awork_tokens_secret_arn
}
