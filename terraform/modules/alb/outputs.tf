output "dns_name" {
  description = "ALB DNS hostname. Use as the Route 53 alias target."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  description = "ALB hosted zone ID. Required to build the Route 53 alias record."
  value       = aws_lb.this.zone_id
}

output "arn" {
  description = "ALB ARN. Pass to the WAFv2 association resource when wiring WAF."
  value       = aws_lb.this.arn
}

output "target_group_arn" {
  description = "Target group ARN. Wire the ECS service's load_balancer block to this."
  value       = aws_lb_target_group.app.arn
}

output "security_group_id" {
  description = "ALB security group. Reference if you need to grant additional ingress from other sources."
  value       = aws_security_group.alb.id
}

output "target_security_group_id" {
  description = "Targets' SG — attach this to the ECS service so the ALB can reach the tasks on the container port."
  value       = aws_security_group.targets.id
}

output "https_listener_arn" {
  description = "HTTPS listener ARN. Useful if you want to add more listener rules later (e.g. path-based routing to a second service)."
  value       = aws_lb_listener.https.arn
}
