variable "environment" {
  description = "Deployment environment slug. Becomes part of resource names + the DANTE_ENV runtime var (so the Lambda reads the right Secrets Manager prefix)."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "package_zip_path" {
  description = "Path to the pre-built Lambda deployment zip (produced by `npm run build:sync-lambda`)."
  type        = string
}

variable "package_source_hash" {
  description = "Hash of the source files that produced the zip. Forces a Lambda update when source changes even if Terraform re-runs without rebuilding."
  type        = string
  default     = ""
}

variable "secret_arns" {
  description = "List of Secrets Manager ARNs the Lambda may read. Pass `module.secrets.all_secret_arns` from the env."
  type        = list(string)
}

variable "writable_secret_arns" {
  description = "Subset of Secrets Manager ARNs the Lambda may write to via PutSecretValue. Today only the awork rotating-tokens secret — the OAuth refresh on every sync writes the rotated tokens back. Keep this list as small as possible; reads are governed separately by `secret_arns`."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN used to decrypt the app secrets. Pass `module.secrets.kms_key_arn` or null if using the AWS-managed key."
  type        = string
  default     = null
}

variable "database_secret_arn" {
  description = "ARN of the RDS-managed master credentials secret (`module.rds.master_user_secret_arn`). The Lambda reads this at boot to compose DATABASE_URL. Pass null only when the function deploys before RDS exists."
  type        = string
  default     = null
}

variable "database_secret_kms_key_arn" {
  description = "KMS key ARN protecting the RDS master secret (`module.rds.master_user_secret_kms_key_id`). Only needed if the secret uses a customer-managed key — leave null for the default `aws/secretsmanager` key."
  type        = string
  default     = null
}

variable "database_endpoint" {
  description = "RDS endpoint (host:port). Composed with the secret to form DATABASE_URL at runtime. Pass null when database_secret_arn is null."
  type        = string
  default     = null
}

variable "database_name" {
  description = "Postgres database name to connect to. Pass `module.rds.database_name`."
  type        = string
  default     = null
}

variable "rds_iam_db_user_arns" {
  description = "RDS IAM-auth DB user ARNs the Lambda execution role can call `rds-db:connect` on. Format: `arn:aws:rds-db:<region>:<account>:dbuser:<rds_resource_id>/<dbuser>`. Empty list = no IAM-auth grant (Lambda falls back to the static-credential paths via DANTE_DATABASE_SECRET_ARN or env-injected DB_USERNAME/DB_PASSWORD)."
  type        = list(string)
  default     = []
}

variable "app_db_username" {
  description = "Postgres username the Lambda's runtime connects as via IAM auth. Wired into the env as DANTE_APP_DB_USERNAME. Required when rds_iam_db_user_arns is non-empty; ignored otherwise."
  type        = string
  default     = null
}

variable "vpc_config" {
  description = "VPC wiring so the Lambda can reach RDS in a private subnet. Set to null only for `environment = local` (LocalStack). Required for dev/prod — RDS lives in a private subnet there."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null

  validation {
    # Enforced together with `var.environment` below: see the cross-field
    # check in the locals block in main.tf.
    condition     = var.vpc_config == null ? true : length(var.vpc_config.subnet_ids) > 0 && length(var.vpc_config.security_group_ids) > 0
    error_message = "When vpc_config is set, subnet_ids and security_group_ids must each contain at least one entry."
  }
}

variable "skip_vpc_check" {
  description = "Escape hatch: set true to allow a non-local environment to deploy without VPC config. Only use for LocalStack-emulated dev or one-off bare-Lambda smoke tests."
  type        = bool
  default     = false
}

variable "schedule_expression" {
  description = "EventBridge schedule expression. Examples: `rate(1 hour)`, `cron(0 6 * * ? *)` (06:00 UTC daily). Set to empty string to skip creating the schedule (useful for ad-hoc-invoke-only deployments)."
  type        = string
  default     = "cron(0 6 * * ? *)"
}

variable "schedule_input_json" {
  description = "Static JSON payload EventBridge passes to the Lambda on each invocation. Defaults to `{}` which means runSync(opts={}), i.e. all sources / all subsyncs."
  type        = string
  default     = "{}"
}

variable "memory_size" {
  description = "Lambda memory in MB. The sync's bottleneck is the upstream API round-trips, not CPU — 512 is plenty unless the awork time-entry pull grows past a few thousand rows."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Lambda timeout in seconds. Personio + awork pulls together typically take 1-3 minutes; the cap is 900s."
  type        = number
  default     = 300

  validation {
    condition     = var.timeout > 0 && var.timeout <= 900
    error_message = "Lambda timeout must be between 1 and 900 seconds."
  }
}

variable "reserved_concurrent_executions" {
  description = "Maximum concurrent Lambda invocations. Bounds the RDS connection footprint: each running sync holds one pg connection, so this caps Lambda's share of RDS max_connections. 2 allows one in-flight + one overlapping if the cron fires before the prior run finishes; 0 throttles the function to zero (use for incident response); -1 disables the reservation entirely — fall back to the account-wide pool. Use -1 only when the account-wide concurrency quota is too low for any reservation (e.g. AWS Free Plan)."
  type        = number
  default     = 2

  validation {
    condition     = var.reserved_concurrent_executions >= -1
    error_message = "reserved_concurrent_executions must be >= -1 (-1 disables the reservation, 0 throttles to zero, >=1 reserves that many)."
  }
}

variable "alarm_email_addresses" {
  description = "Email addresses subscribed to the alarm SNS topic. Each address receives a confirmation email after `terraform apply` — the subscription is pending until confirmed. Pass an empty list to skip email and wire your own subscription downstream (e.g. PagerDuty)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.alarm_email_addresses : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Each alarm_email_address must be a valid email."
  }
}

variable "dlq_message_retention_seconds" {
  description = "How long failed events sit in the DLQ before being purged. 14 days gives an operator plenty of time to investigate and replay; max is 14 days (1209600s)."
  type        = number
  default     = 1209600
}
