output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "ECS service name. Trigger deploys with: aws ecs update-service --cluster <cluster> --service <name> --force-new-deployment"
  value       = aws_ecs_service.this.name
}

output "task_definition_arn" {
  description = "Task definition ARN (versioned). The :revision portion increments on each terraform apply that changes the task def."
  value       = aws_ecs_task_definition.this.arn
}

output "task_definition_family" {
  description = "Task definition family — useful for `aws ecs register-task-definition` from CI without a Terraform round-trip."
  value       = aws_ecs_task_definition.this.family
}

output "task_role_arn" {
  description = "Task role ARN — useful if you need to grant additional AWS permissions outside this module (e.g. attach a policy from another env)."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "ECS execution role ARN."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "CloudWatch log group the app writes to."
  value       = aws_cloudwatch_log_group.app.name
}
