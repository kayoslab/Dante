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

variable "deploy_role_environments" {
  description = "GitHub Actions Environment names that may also assume the deploy role. GitHub re-scopes the OIDC `sub` claim to `repo:<owner>/<repo>:environment:<name>` for any job that declares `environment: <name>` — workflows without an environment use the branch-shaped sub (`ref:refs/heads/<branch>`) controlled by `deploy_role_branch_filter`. Both shapes need to be allowed if a workflow has both kinds of jobs."
  type        = list(string)
  default     = []
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

variable "managed_iam_role_arns" {
  description = "IAM role ARNs whose INLINE policies the deploy role may write via iam:PutRolePolicy / DeleteRolePolicy. Needed when a module's inline policy (e.g. sync-lambda's secrets statement) is modified by terraform on apply. Scope tightly — granting blanket iam:PutRolePolicy lets a compromised deploy token rewrite arbitrary role permissions. The deploy role's own ARN MUST NOT appear here (would allow self-modification)."
  type        = list(string)
  default     = []
}

variable "eventbridge_rule_arns" {
  description = "EventBridge rule ARNs the deploy role may modify (PutRule, DeleteRule, PutTargets, RemoveTargets, TagResource, UntagResource). Pass the sync Lambda's schedule rule ARN here so terraform can update the cron expression or rule tags on apply."
  type        = list(string)
  default     = []
}

variable "sns_topic_arns" {
  description = "SNS topic ARNs the deploy role may manage (Subscribe/Unsubscribe email recipients, Get/SetTopicAttributes, Tag/UntagResource). Pass every alarm topic terraform owns. Unsubscribe resource ARNs are subscription ARNs (not topic ARNs) and AWS doesn't support resource-level scoping for them — Unsubscribe + subscription-attribute reads are granted on `*`, gated by the OIDC trust condition."
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

variable "rds_db_instance_arns" {
  description = "RDS instance ARNs the deploy role may modify in-place. Currently scoped to the actions needed by the IAM-auth toggle (`rds:ModifyDBInstance`) and routine drift reconciliation (`rds:DescribeDBInstances`, `rds:ListTagsForResource`, `rds:AddTagsToResource`, `rds:RemoveTagsFromResource`). Destructive actions (DeleteDBInstance, RebootDBInstance, RestoreDBInstanceFromSnapshot) deliberately excluded — terraform doesn't need them in normal operation, and adding them via the deploy role would let a compromised CI token wipe the database."
  type        = list(string)
  default     = []
}

variable "secret_arns_read_write" {
  description = "Secret ARNs whose VALUE terraform manages (i.e. has a matching `aws_secretsmanager_secret_version` resource). CI gets `secretsmanager:GetSecretValue` + `PutSecretValue` on these so plan can refresh-compare and apply can rewrite. In practice this is just the cognito_client_secret. Other secrets where terraform only creates the container go to `secret_arns_describe_only` instead — keeping `GetSecretValue` off them stops a compromised CI token from walking away with every prod credential."
  type        = list(string)
  default     = []
}

variable "secret_arns_describe_only" {
  description = "Secret ARNs whose container terraform creates but whose VALUE is written out-of-band (by the operator, OAuth callback, RDS rotation, etc.). CI gets `DescribeSecret` + tag actions only; no `GetSecretValue`. Use for everything that's not in `secret_arns_read_write`."
  type        = list(string)
  default     = []
}
