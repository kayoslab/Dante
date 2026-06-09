output "check_role_arn" {
  description = "ARN of the check role. Set as a GitHub repo variable so the check workflow can `aws-actions/configure-aws-credentials@v4 role-to-assume`."
  value       = aws_iam_role.check.arn
}

output "deploy_role_arn" {
  description = "ARN of the deploy role. Set as a GitHub repo variable; only workflows on the protected branch can assume it."
  value       = aws_iam_role.deploy.arn
}

output "oidc_provider_arn" {
  description = "ARN of the OIDC provider. Useful if other modules need to grant additional roles to GitHub-issued tokens."
  value       = local.oidc_arn
}
