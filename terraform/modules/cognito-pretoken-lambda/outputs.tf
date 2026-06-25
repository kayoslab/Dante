output "function_arn" {
  description = "ARN of the deployed Lambda. Pass into the cognito module via `pre_token_generation_lambda_arn`."
  value       = aws_lambda_function.this.arn
}

output "function_name" {
  description = "Lambda function name. Useful for CloudWatch query construction."
  value       = aws_lambda_function.this.function_name
}

output "log_group_name" {
  description = "CloudWatch log group name. Useful for metric filters on `pretoken_scope_suppression` events."
  value       = aws_cloudwatch_log_group.this.name
}
