variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

# --- placement -------------------------------------------------------------

variable "vpc_id" {
  description = "VPC the tasks run in."
  type        = string
}

variable "app_subnet_ids" {
  description = "App-tier private subnets the tasks place into."
  type        = list(string)

  validation {
    condition     = length(var.app_subnet_ids) >= 2
    error_message = "Run tasks across at least 2 subnets for AZ resilience."
  }
}

variable "target_group_arn" {
  description = "ALB target group ARN. The service registers tasks here."
  type        = string
}

variable "task_security_group_id" {
  description = "Security group ID attached to the tasks. The ALB module provides this — already has ingress from the ALB on the container port."
  type        = string
}

# --- image -----------------------------------------------------------------

variable "image_uri" {
  description = "Full ECR image URI including tag, e.g. `123456789012.dkr.ecr.eu-central-1.amazonaws.com/dante-prod-app:abc1234`. Pin to a specific tag/SHA — never `:latest` in prod."
  type        = string
}

variable "container_port" {
  description = "Port the container listens on. Next.js's `next start` defaults to 3000."
  type        = number
  default     = 3000
}

# --- task sizing -----------------------------------------------------------

variable "cpu" {
  description = "Fargate task CPU units. Valid combos: 256+0.5GB, 512+1GB, 1024+2GB, etc. See AWS docs for the full list."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory in MB. Must match a valid CPU combo (see `cpu` above)."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "How many tasks to run. 2 for HA across AZs; 1 for cost-cutting in pre-prod."
  type        = number
  default     = 2
}

variable "deployment_min_healthy_percent" {
  description = "Rolling-deploy floor. 100 keeps the current capacity online during the rollover (zero-downtime)."
  type        = number
  default     = 100
}

variable "deployment_max_percent" {
  description = "Rolling-deploy ceiling. 200 lets the new revision spin up alongside the old before old tasks drain. Together with min=100 this is the standard zero-downtime config."
  type        = number
  default     = 200
}

variable "health_check_grace_period_seconds" {
  description = "Time the ALB ignores health checks after a task starts. Next.js cold-start is ~5-10s; 60 gives plenty of slack."
  type        = number
  default     = 60
}

# --- runtime config --------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention for the app log group."
  type        = number
  default     = 30
}

variable "environment_variables" {
  description = "Plaintext environment variables for the container. NEVER put secrets here — use `secrets` instead."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets to inject from Secrets Manager / SSM Parameter Store. Each `value_from` is either a secret ARN (entire JSON) or `<arn>:<key>::` for a single key from a JSON secret."
  type = list(object({
    name       = string
    value_from = string
  }))
  default = []
}

variable "additional_secret_arns_readable" {
  description = "Extra Secrets Manager ARNs the task role should be able to read (e.g. tokens fetched lazily by app code, not declared in `secrets`)."
  type        = list(string)
  default     = []
}

variable "additional_secret_arns_writable" {
  description = "Secrets Manager ARNs the task role can WRITE but not READ. Use for rotating tokens the app updates but doesn't need to load back from Secrets Manager (e.g. awork OAuth tokens stored after the interactive callback). An RCE'd app can overwrite these but cannot exfiltrate them."
  type        = list(string)
  default     = []
}

variable "additional_kms_key_arns_decryptable" {
  description = "Extra KMS key ARNs the task role can use for `kms:Decrypt`. Required when secrets are encrypted with a customer-managed key."
  type        = list(string)
  default     = []
}

variable "additional_invokable_lambda_arns" {
  description = "Lambda function ARNs the task role can call `lambda:InvokeFunction` on. Use to keep the web-app task out of sensitive credential read paths by routing work through a Lambda with narrower IAM (e.g. the sync Lambda owns Personio + awork creds; the web app only invokes it). Each ARN should be fully-qualified including the function name."
  type        = list(string)
  default     = []
}
