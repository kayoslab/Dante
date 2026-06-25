output "user_pool_id" {
  description = "Cognito User Pool ID. Goes into the app as COGNITO_USER_POOL_ID."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Pool ARN. Used by IAM policies that grant the app permission to call admin APIs."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Endpoint to use as the issuer URL for JWT verification."
  value       = aws_cognito_user_pool.this.endpoint
}

output "client_id" {
  description = "App client ID. Goes into the app as COGNITO_CLIENT_ID."
  value       = aws_cognito_user_pool_client.app.id
}

output "client_secret" {
  description = "App client secret. Sensitive — store in Secrets Manager, never commit. Auth.js needs this server-side."
  value       = aws_cognito_user_pool_client.app.client_secret
  sensitive   = true
}

output "oauth_domain" {
  description = "The Cognito-hosted OAuth domain (e.g. dante-dev-abc123). Used to build issuer and OIDC endpoint URLs."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "issuer_url" {
  description = "OIDC issuer URL. Auth.js uses this to discover endpoints and fetch the JWKS for token verification."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}

output "oauth_endpoint" {
  description = "Base OAuth URL — the custom domain when configured, otherwise the default Cognito-hosted one."
  value       = var.custom_domain_name != null ? "https://${var.custom_domain_name}" : "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "custom_domain_cloudfront_distribution" {
  description = "CloudFront distribution domain for the custom Cognito hosted-UI domain. Use as the A-alias target in Route 53. Null when no custom domain is configured."
  value       = var.custom_domain_name == null ? null : aws_cognito_user_pool_domain.custom[0].cloudfront_distribution
}

data "aws_region" "current" {}
