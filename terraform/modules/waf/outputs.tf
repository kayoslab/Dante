output "web_acl_arn" {
  description = "Web ACL ARN. Useful for referencing in cross-account log delivery or for attaching to additional resources."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_id" {
  description = "Web ACL ID."
  value       = aws_wafv2_web_acl.this.id
}

output "web_acl_name" {
  description = "Web ACL name — appears in CloudWatch metric dimensions."
  value       = aws_wafv2_web_acl.this.name
}

output "log_group_name" {
  description = "CloudWatch log group receiving WAF events, or null if logging disabled."
  value       = try(aws_cloudwatch_log_group.waf[0].name, null)
}

output "alarm_topic_arn" {
  description = "SNS topic ARN for WAF alarms, or null if no alarm emails were configured."
  value       = try(aws_sns_topic.alarms[0].arn, null)
}
