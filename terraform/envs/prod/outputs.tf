output "cognito_user_pool_id" {
  description = "Set as COGNITO_USER_POOL_ID in the prod Lambda + ECS env."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "Set as COGNITO_CLIENT_ID in the prod Lambda + ECS env."
  value       = module.cognito.client_id
}

output "cognito_client_secret" {
  description = "Set as COGNITO_CLIENT_SECRET. Read with: terraform output -raw cognito_client_secret"
  value       = module.cognito.client_secret
  sensitive   = true
}

output "cognito_issuer_url" {
  description = "Set as COGNITO_ISSUER in the prod env."
  value       = module.cognito.issuer_url
}

output "cognito_oauth_endpoint" {
  description = "Set as COGNITO_OAUTH_ENDPOINT in the prod env (used for the Auth.js wellKnown URL)."
  value       = module.cognito.oauth_endpoint
}

output "personio_secret_arn" {
  description = "Pass into the sync-lambda module's `secret_arns` list."
  value       = module.secrets.personio_secret_arn
}

output "awork_client_secret_arn" {
  description = "Pass into the sync-lambda module's `secret_arns` list."
  value       = module.secrets.awork_client_secret_arn
}

output "awork_tokens_secret_arn" {
  description = "Pass into the sync-lambda module's `secret_arns` list."
  value       = module.secrets.awork_tokens_secret_arn
}

output "all_secret_arns" {
  description = "All app secret ARNs — feed directly into sync-lambda module's `secret_arns`."
  value       = module.secrets.all_secret_arns
}

output "sync_lambda_function_name" {
  description = "Sync Lambda function name. Invoke ad-hoc: aws lambda invoke --function-name <name> --payload '{}' /tmp/out.json"
  value       = module.sync_lambda.function_name
}

output "sync_lambda_dlq_url" {
  description = "Sync Lambda DLQ URL. Inspect failed invocations: aws sqs receive-message --queue-url <url>"
  value       = module.sync_lambda.dlq_url
}

output "sync_lambda_alarm_topic_arn" {
  description = "SNS topic ARN for sync Lambda alarms. Add PagerDuty / Slack subscriptions out-of-band."
  value       = module.sync_lambda.alarm_topic_arn
}

# --- VPC ----------------------------------------------------------------

output "vpc_id" {
  description = "Prod VPC. Pass into the future ECS / WAF / DNS modules."
  value       = module.vpc.vpc_id
}

output "vpc_app_subnet_ids" {
  description = "App-tier private subnets — for ECS tasks + Lambda ENIs."
  value       = module.vpc.app_subnet_ids
}

output "vpc_public_subnet_ids" {
  description = "Public subnets — for the ALB."
  value       = module.vpc.public_subnet_ids
}

# --- RDS ----------------------------------------------------------------

output "rds_endpoint" {
  description = "RDS endpoint (host:port). Wire into ECS task env or read via the master_user_secret."
  value       = module.rds.endpoint
}

output "rds_database_name" {
  description = "RDS initial database name."
  value       = module.rds.database_name
}

output "rds_master_user_secret_arn" {
  description = "ARN of the RDS-managed master credential secret. Pass into the ECS task definition's `secrets:` block when the app module lands."
  value       = module.rds.master_user_secret_arn
}

output "rds_security_group_id" {
  description = "SG attached to the RDS instance. Reference as an ingress source when wiring future app SGs."
  value       = module.rds.security_group_id
}

# --- App ----------------------------------------------------------------

output "ecr_repository_url" {
  description = "ECR repo URL. Push the app container here: docker push <url>:<sha>"
  value       = module.ecr.repository_url
}

output "alb_dns_name" {
  description = "ALB DNS name. The DNS module aliases `var.domain` to this."
  value       = module.alb.dns_name
}

output "app_domain" {
  description = "Public app URL (after DNS propagation + ACM validation)."
  value       = "https://${module.dns.domain_name}"
}

output "app_cluster_name" {
  description = "ECS cluster name. Trigger an in-place redeploy with: aws ecs update-service --cluster <name> --service <service> --force-new-deployment"
  value       = module.app.cluster_name
}

output "app_service_name" {
  description = "ECS service name."
  value       = module.app.service_name
}

output "app_log_group" {
  description = "CloudWatch log group the app writes to."
  value       = module.app.log_group_name
}

# --- WAF ----------------------------------------------------------------

output "waf_web_acl_arn" {
  description = "WAFv2 Web ACL ARN."
  value       = module.waf.web_acl_arn
}

output "waf_log_group" {
  description = "WAF logs land here. Inspect with: aws logs tail <name> --follow"
  value       = module.waf.log_group_name
}

output "waf_alarm_topic_arn" {
  description = "SNS topic for WAF alarms. Add PagerDuty / Slack subs out-of-band."
  value       = module.waf.alarm_topic_arn
}
