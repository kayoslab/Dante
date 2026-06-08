variable "aws_region" {
  description = "AWS region for prod resources. Frankfurt is required for GDPR — employee data is processed in the EU."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "Prod must run in eu-central-1 (Frankfurt) for GDPR compliance. Override only after legal review of the destination region."
  }
}

variable "domain" {
  description = "Public hostname the prod app is served from. Used to derive Cognito callback and logout URLs."
  type        = string
  default     = "dante.example.com"
}

variable "seed_admin_emails" {
  description = "Email addresses to invite as admin users into the prod Cognito pool. Cognito emails each a temp password."
  type        = list(string)
  default     = ["admin@example.com"]

  validation {
    condition     = length(var.seed_admin_emails) >= 1
    error_message = "Prod must seed at least one admin; otherwise no one can sign in to the new pool."
  }
}

# --- sync Lambda --------------------------------------------------------

variable "sync_lambda_package_zip_path" {
  description = "Path to the pre-built sync Lambda zip. Run `npm run build:sync-lambda` from `frontend/` before applying; the script writes to this default path."
  type        = string
  default     = "../../../frontend/dist/lambda/dante-sync-lambda.zip"
}

variable "sync_lambda_alarm_emails" {
  description = "Email addresses subscribed to the sync Lambda's CloudWatch alarm SNS topic. Each receives a confirmation email after the first apply."
  type        = list(string)
  default     = ["admin@example.com"]
}

variable "sync_lambda_schedule_expression" {
  description = "EventBridge schedule for the sync Lambda. Default: 06:00 UTC daily, which is 07:00–08:00 Frankfurt local time (winter/summer) — before the working day starts."
  type        = string
  default     = "cron(0 6 * * ? *)"
}

# --- VPC ---------------------------------------------------------------

variable "vpc_cidr_block" {
  description = "Prod VPC CIDR. /16 leaves room for /24 subnets across 2-3 AZs."
  type        = string
  default     = "10.0.0.0/16"
}

variable "vpc_az_count" {
  description = "Number of AZs to spread subnets across. 2 = minimum for RDS Multi-AZ readiness; 3 adds headroom."
  type        = number
  default     = 2
}

variable "vpc_single_nat_gateway" {
  description = "One NAT for all AZs (saves ~€32/mo) vs one-per-AZ (no SPOF). For a 40-user internal tool, single NAT is the right trade-off; flip when uptime SLAs demand it."
  type        = bool
  default     = true
}

# --- RDS ---------------------------------------------------------------

variable "rds_instance_class" {
  description = "Prod RDS instance class. t4g.micro covers 40 users; bump to t4g.small if buffer cache pressure or analytic queries show up in Performance Insights."
  type        = string
  default     = "db.t4g.micro"
}

variable "rds_multi_az" {
  description = "Enable Multi-AZ for prod RDS. Doubles cost. Off day-1; flip on once steady-state confirms the workload and budget."
  type        = bool
  default     = false
}

variable "rds_engine_version" {
  description = "Pinned Postgres major.minor. Match what's running locally (`postgres:16-alpine`)."
  type        = string
  default     = "16.4"
}

# --- DNS ---------------------------------------------------------------

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for the parent domain (the zone hosting `example.com`). Required for ACM DNS validation + the A-alias record on `var.domain`."
  type        = string
}

# --- ECS app -----------------------------------------------------------

variable "app_image_uri" {
  description = "Full ECR image URI including tag for the Next.js app. Push first (`docker push <repo_url>:<sha>`), then pass `<repo_url>:<sha>` here. Never `:latest` in prod."
  type        = string
}

variable "app_cpu" {
  description = "Fargate task CPU. 512 = 0.5 vCPU."
  type        = number
  default     = 512
}

variable "app_memory" {
  description = "Fargate task memory in MB."
  type        = number
  default     = 1024
}

variable "app_desired_count" {
  description = "Number of running tasks. 2 for HA across AZs."
  type        = number
  default     = 2
}

# --- WAF ---------------------------------------------------------------

variable "waf_geo_allow_list" {
  description = "ISO 3166-1 alpha-2 country codes the WAF allows. Empty list = no geo filter. Example: [\"DE\", \"AT\", \"CH\"] for DACH-only. Be careful — admins traveling outside the list are blocked."
  type        = list(string)
  default     = []
}

variable "waf_alarm_emails" {
  description = "Subscribers for the WAF blocked-spike alarm. Each receives a confirmation email after first apply."
  type        = list(string)
  default     = ["admin@example.com"]
}
