output "function_arn" {
  description = "ARN of the deployed Lambda. Pass into the cognito module via `pre_token_generation_lambda_arn`."
  value       = aws_lambda_function.this.arn
}

output "role_arn" {
  description = "ARN of the Lambda execution role. Pass into the GitHub OIDC module's `lambda_role_arns_passable` so CI's PassRole grant covers it. (Without it, terraform's first CreateFunction call fails with `passrole`.)"
  value       = aws_iam_role.lambda.arn
}

output "function_name" {
  description = "Lambda function name. Useful for CloudWatch query construction."
  value       = aws_lambda_function.this.function_name
}

output "log_group_name" {
  description = "CloudWatch log group name. Useful for metric filters on `pretoken_scope_suppression` events."
  value       = aws_cloudwatch_log_group.this.name
}
