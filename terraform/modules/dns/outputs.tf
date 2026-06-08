output "certificate_arn" {
  description = "ACM certificate ARN — pass to the ALB module's `certificate_arn`."
  value       = aws_acm_certificate_validation.this.certificate_arn
}

output "domain_name" {
  description = "Domain the app is reachable at."
  value       = aws_route53_record.app.name
}
