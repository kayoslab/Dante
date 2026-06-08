output "repository_url" {
  description = "Repository URL. Push with: docker tag <local> <url>:<sha> && docker push <url>:<sha>"
  value       = aws_ecr_repository.this.repository_url
}

output "repository_arn" {
  description = "Repository ARN. Used in IAM policies for the ECS task execution role (so the task can pull images)."
  value       = aws_ecr_repository.this.arn
}

output "repository_name" {
  description = "Repository name (without registry prefix)."
  value       = aws_ecr_repository.this.name
}
