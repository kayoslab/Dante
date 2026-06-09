variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "github_repository" {
  description = "GitHub repo in `owner/repo` form, e.g. `cr0ss/dante`. The trust policy is scoped to this repo's workflows — no other repo's OIDC tokens can assume the role."
  type        = string
}

variable "create_oidc_provider" {
  description = "When true, this module creates the account-wide IAM OIDC provider for `token.actions.githubusercontent.com`. Set to false in environments that import a provider provisioned by another module / account-bootstrap stack. There can only be ONE OIDC provider for this issuer per AWS account."
  type        = bool
  default     = true
}

variable "deploy_role_branch_filter" {
  description = "Only allow the deploy role to be assumed by workflows on this branch (default `main`). Limits blast radius if a feature branch is compromised. Set to `*` to allow any branch."
  type        = string
  default     = "main"
}

variable "ecr_repository_arn" {
  description = "ECR repo the deploy role is allowed to push to."
  type        = string
}

variable "ecs_cluster_arn" {
  description = "ECS cluster ARN. The deploy role gets permission to update services + register task definitions on this cluster."
  type        = string
}

variable "ecs_service_arns" {
  description = "ECS service ARNs the deploy role can update (force-new-deployment)."
  type        = list(string)
}

variable "lambda_function_arns" {
  description = "Lambda functions the deploy role can update code on (sync Lambda + future Lambdas)."
  type        = list(string)
  default     = []
}

variable "task_role_arns_passable" {
  description = "Task / execution role ARNs the deploy role may pass to ECS (iam:PassRole). Pass these from the ecs-app module's outputs."
  type        = list(string)
  default     = []
}

variable "terraform_state_bucket_arn" {
  description = "ARN of the S3 bucket holding Terraform remote state. Pass null while running on local backend; when you migrate to S3, plumb this through so the deploy role can read/write state."
  type        = string
  default     = null
}

variable "terraform_state_lock_table_arn" {
  description = "DynamoDB table ARN used for Terraform state locking. Pass null when state is local."
  type        = string
  default     = null
}
