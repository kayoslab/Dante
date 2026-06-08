output "function_name" {
  description = "Lambda function name. Useful when invoking ad-hoc via aws-cli (`aws lambda invoke --function-name <name>`)."
  value       = aws_lambda_function.sync.function_name
}

output "function_arn" {
  description = "Lambda function ARN."
  value       = aws_lambda_function.sync.arn
}

output "role_arn" {
  description = "Lambda execution role ARN."
  value       = aws_iam_role.lambda.arn
}

output "log_group_name" {
  description = "CloudWatch log group the Lambda writes to."
  value       = aws_cloudwatch_log_group.sync.name
}

output "schedule_rule_name" {
  description = "EventBridge schedule rule name, or null if no schedule was configured."
  value       = try(aws_cloudwatch_event_rule.schedule[0].name, null)
}

output "dlq_arn" {
  description = "ARN of the SQS DLQ that catches failed async-invocations."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  description = "URL of the SQS DLQ. Inspect failures with: aws sqs receive-message --queue-url <url>"
  value       = aws_sqs_queue.dlq.url
}

output "alarm_topic_arn" {
  description = "SNS topic ARN that all CloudWatch alarms publish to. Wire additional subscriptions (PagerDuty, Slack) here."
  value       = aws_sns_topic.alarms.arn
}
