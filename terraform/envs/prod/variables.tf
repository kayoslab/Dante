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
  description = "Public hostname the prod app is served from (e.g. `dante.example.com`). Used to derive Cognito callback / logout URLs, the Cognito hosted-UI custom domain (`auth.<domain>`), and the SES sender identity. No default — supplied by CI from the `APP_DOMAIN` repository variable, or via a gitignored `*.auto.tfvars` for manual applies."
  type        = string
}

variable "parent_domain" {
  description = "Corporate parent domain (e.g. `example.com`) whose Route 53 zone (`hosted_zone_id`) hosts `var.domain`. Verified as an SES identity so that, while the SES account is sandboxed, every mailbox on the parent domain is a valid recipient for Cognito invite / reset mail. Supplied by CI from the `PARENT_DOMAIN` repository variable."
  type        = string
}

variable "seed_admin_emails" {
  description = "Email addresses to invite as admin users into the prod Cognito pool. Cognito emails each a temp password. Supplied by CI from the `SEED_ADMIN_EMAILS` repository variable (JSON list)."
  type        = list(string)

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
  description = "Email addresses subscribed to the sync Lambda's CloudWatch alarm SNS topic. Each receives a confirmation email after the first apply. Supplied by CI from the `SYNC_LAMBDA_ALARM_EMAILS` repository variable (JSON list)."
  type        = list(string)
}

variable "sync_lambda_schedule_expression" {
  description = "EventBridge schedule for the sync Lambda. Default: every 6 hours at 04:00, 10:00, 16:00, and 22:00 UTC. The 04:00 run (05:00–06:00 Frankfurt local, winter/summer) still lands before the 08:00 standup so overnight changes are in before people start working; the three daytime runs keep Personio + awork data fresh through the workday. A single EventBridge rule fires at all four hours via the comma-list hour field."
  type        = string
  default     = "cron(0 4,10,16,22 * * ? *)"
}

# --- Cognito Pre Token Generation Lambda -------------------------------

variable "cognito_pretoken_lambda_package_zip_path" {
  description = "Path to the pre-built Pre Token Generation Lambda zip. Run `npm run build:cognito-pretoken-lambda` from `frontend/` before applying; the script writes to this default path."
  type        = string
  default     = "../../../frontend/dist/lambda-cognito-pretoken/dante-cognito-pretoken-lambda.zip"
}

# --- Agent integration -------------------------------------------------

variable "agent_callback_urls" {
  description = "OAuth callback URLs allowed for the Cognito agent app client. Covers (1) the EVE TUI's local callback on port 3000, (2) the deployed Vercel agent's EVE connection callback, (3) the test-token-fetch script on port 8765, (4) the Auth.js sign-in callback on the deployed Vercel agent (this is what completes the OAuth Authorization Code flow for browser sign-in via the minos chat UI), plus the local-dev equivalents of (4). Add preview-deploy URLs explicitly when needed — Cognito doesn't accept wildcards on callback URLs. Cognito permits HTTP only for `localhost`; every other entry must be HTTPS."
  type        = list(string)
  default = [
    "http://localhost:3000/eve/v1/connections/dante/auth/callback",
    "http://localhost:3000/api/auth/callback",
    "http://localhost:8765/callback",
    "https://minos-agent.vercel.app/eve/v1/connections/dante/auth/callback",
    "https://minos-agent.vercel.app/api/auth/callback",
  ]
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

variable "vpc_nat_mode" {
  description = "`gateway` (managed NAT Gateway, ~€32/mo) or `instance` (t4g.nano running iptables, ~€3/mo). The instance mode needs a Graviton instance type, which Free Plan accounts cannot launch — keep `gateway` while `aws_free_plan` is true."
  type        = string
  default     = "gateway"
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

variable "rds_backup_retention_days" {
  description = "Automated RDS backup retention in days (enables point-in-time recovery). Ignored — forced to 0 — while `aws_free_plan` is true, because the Free Plan rejects any value above 0."
  type        = number
  default     = 7
}

variable "rds_multi_az" {
  description = "Enable Multi-AZ for prod RDS. Doubles cost. Off day-1; flip on once steady-state confirms the workload and budget."
  type        = bool
  default     = false
}

variable "rds_engine_version" {
  description = "Pinned Postgres major.minor. Match what's running locally (`postgres:16-alpine`). Refresh periodically — AWS retires minor versions over time; check `aws rds describe-db-engine-versions --engine postgres` if a plan errors with 'Cannot find version'."
  type        = string
  default     = "16.14"
}

# --- Account tier ------------------------------------------------------

variable "aws_free_plan" {
  description = "Set to true while the AWS account is on the 2025 Free Plan. That plan rejects several settings this stack uses at its safe defaults, so `true` swaps in the degraded-but-deployable variants: RDS automated backups off (`backup_retention_period = 0`, no point-in-time recovery), no Lambda concurrency reservations (`-1`), and no Inspector v2 enhanced ECR scanning (the deploy workflow's CVE gate is skipped in lockstep). Flip to false as soon as the account is on a paid tier — every override reverts on the next apply. Supplied by CI from the `AWS_FREE_PLAN` repository variable; defaults to false so an unconfigured environment gets the safe settings."
  type        = bool
  default     = false
}

# --- DNS ---------------------------------------------------------------

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for the parent domain (the zone hosting `var.parent_domain`). Required for ACM DNS validation + the A-alias record on `var.domain`. Supplied by CI from the `HOSTED_ZONE_ID` repository variable."
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
  description = "Subscribers for the WAF blocked-spike alarm. Each receives a confirmation email after first apply. Supplied by CI from the `WAF_ALARM_EMAILS` repository variable (JSON list)."
  type        = list(string)
}

variable "waf_enabled" {
  description = "Whether the WAF is associated with the public ALB. Defaults to true. Set to false ONLY for pentest windows when an external tester needs to see the raw application attack surface without WAF filtering. The Web ACL definition stays in place so re-enabling is a one-line flip. Don't ship false to main long-term."
  type        = bool
  default     = true
}

# --- GitHub Actions ----------------------------------------------------

variable "github_repository" {
  description = "GitHub repo in `owner/repo` form (e.g. `your-org/dante`). Drives the OIDC trust policies — only workflows from this repo can assume the check / deploy roles."
  type        = string
}
