output "cognito_user_pool_id" {
  description = "Set as COGNITO_USER_POOL_ID in frontend/.env."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "Set as COGNITO_CLIENT_ID in frontend/.env."
  value       = module.cognito.client_id
}

output "cognito_client_secret" {
  description = "Set as COGNITO_CLIENT_SECRET in frontend/.env. Read with: terraform output -raw cognito_client_secret"
  value       = module.cognito.client_secret
  sensitive   = true
}

output "cognito_issuer_url" {
  description = "Set as COGNITO_ISSUER in frontend/.env."
  value       = module.cognito.issuer_url
}

output "cognito_oauth_endpoint" {
  description = "Set as COGNITO_OAUTH_ENDPOINT in frontend/.env (used for the Auth.js wellKnown URL)."
  value       = module.cognito.oauth_endpoint
}
