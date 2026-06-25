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

# ----------------------------------------------------------------------------
# Agent integration outputs
# ----------------------------------------------------------------------------

output "agent_client_id" {
  description = "Cognito app client ID for the agent integration (Vercel EVE etc.). Give this to the agent operator alongside the OAuth endpoints + scope list; they paste it into their EVE Connection config. Not sensitive (public OAuth client)."
  value       = aws_cognito_user_pool_client.agents.id
}

output "agent_resource_server_identifier" {
  description = "Resource Server identifier (`dante-agents`). The `scope` claim on issued access tokens uses this as a prefix: `dante-agents/read:projects` etc. The app strips the prefix before matching against the local scope catalog."
  value       = aws_cognito_resource_server.agents.identifier
}

output "agent_scopes_qualified" {
  description = "Fully-qualified scope strings agents request at /oauth2/authorize. Hand the list to the agent operator so they don't have to compose the strings themselves."
  value       = [for s in var.agent_scopes : "${aws_cognito_resource_server.agents.identifier}/${s.name}"]
}

data "aws_region" "current" {}
