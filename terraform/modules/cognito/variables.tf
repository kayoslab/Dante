variable "environment" {
  description = "Environment name (dev / prod). Used in resource names and tags."
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be 'dev' or 'prod'."
  }
}

variable "name_prefix" {
  description = "Prefix for resources, e.g. 'dante'."
  type        = string
  default     = "dante"
}

variable "callback_urls" {
  description = "OAuth callback URLs allowed for the app client. Auth.js requires /api/auth/callback/cognito."
  type        = list(string)
}

variable "domain_name" {
  description = "Public domain the app is hosted on (e.g. dante.example.com). Used as the WebAuthn relying-party ID — passkeys are scoped to this exact domain so credentials can't be replayed elsewhere."
  type        = string
}

variable "logout_urls" {
  description = "Sign-out redirect URLs allowed for the app client."
  type        = list(string)
}

variable "seed_admin_emails" {
  description = "Email addresses that will receive a Cognito invitation and be auto-added to the 'admin' group. Cognito generates a temp password and sends a welcome email."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for e in var.seed_admin_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Each seed_admin_email must be a syntactically valid email address."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource in the module."
  type        = map(string)
  default     = {}
}

variable "custom_domain_name" {
  description = "Optional custom domain for the Cognito hosted UI (e.g. auth.dante.example.com). Must share an eTLD+1 with `domain_name` so WebAuthn passkeys registered on the app domain also work at sign-in. Leave null to use the default `*.amazoncognito.com` Cognito domain only."
  type        = string
  default     = null
}

variable "custom_domain_cert_arn" {
  description = "ACM certificate ARN for `custom_domain_name`. The cert MUST be in us-east-1 (Cognito requirement). Required when custom_domain_name is set."
  type        = string
  default     = null
}

variable "ses_source_arn" {
  description = "ARN of a verified SES email identity (domain or address). When set, Cognito sends invitation / forgot-password / MFA-setup emails through SES instead of its default sender. Required for production — the default sender is rate-limited to 50/day and frequently spam-filtered. Leave null to keep Cognito's default sender."
  type        = string
  default     = null
}

variable "ses_from_email_address" {
  description = "FROM address Cognito uses when sending via SES. Format: `Friendly Name <noreply@example.com>` or bare `noreply@example.com`. Must be covered by `ses_source_arn` (a domain identity covers any address on that domain). Ignored when `ses_source_arn` is null."
  type        = string
  default     = null
}

variable "ses_reply_to_email_address" {
  description = "Optional Reply-To set on Cognito-generated emails. Users hitting reply land here instead of bouncing off the FROM address. Ignored when `ses_source_arn` is null."
  type        = string
  default     = null
}

variable "advanced_security_mode" {
  description = "Cognito Threat Protection (formerly Advanced Security): adaptive auth, IP-based throttling, compromised-credentials detection. Choices: OFF, AUDIT (log risk events only), ENFORCED (block / step-up on risky sign-ins). Requires `user_pool_tier = PLUS`. ENFORCED is the right default for prod; AUDIT for staging when tuning."
  type        = string
  default     = "OFF"
  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.advanced_security_mode)
    error_message = "advanced_security_mode must be OFF, AUDIT, or ENFORCED."
  }
}

variable "user_pool_tier" {
  description = "Cognito user pool pricing tier. LITE = no MFA + no advanced features. ESSENTIALS = MFA + custom domain. PLUS = ESSENTIALS + Threat Protection (adaptive auth, IP throttling, compromised-credentials checks). Must be PLUS to set `advanced_security_mode` to AUDIT or ENFORCED. Cost difference at 40 MAU is roughly $2/mo PLUS vs ESSENTIALS."
  type        = string
  default     = "ESSENTIALS"
  validation {
    condition     = contains(["LITE", "ESSENTIALS", "PLUS"], var.user_pool_tier)
    error_message = "user_pool_tier must be LITE, ESSENTIALS, or PLUS."
  }
}

# ----------------------------------------------------------------------------
# Agent integration (`/api/agent/*`)
# ----------------------------------------------------------------------------

variable "agent_scopes" {
  description = "Custom scopes published on the dante-agents Resource Server. Each entry becomes one OAuth scope clients can request (formatted by Cognito as `dante-agents/<name>`). The set should mirror the catalog in `lib/auth/agent-scopes.ts` in the app — adding a scope here without updating the app is harmless (the scope just isn't recognized when validated)."
  type = list(object({
    name        = string
    description = string
  }))
  default = [
    { name = "read:projects", description = "List projects + per-project monthly P&L." },
    { name = "read:customers", description = "List customers + their frameworks + rates." },
    { name = "read:reports", description = "Portfolio + customer rentability rollups (no per-employee data)." },
    { name = "read:employees", description = "List employees, teams, role tiers. No salary / Personio personal data." },
    { name = "read:salaries", description = "Per-employee salary history + monthly cost. Manager-only via Pre Token Generation Lambda." },
    { name = "write:customers", description = "Create + update customers. Manager-only; every call parks for explicit user confirmation in the agent UI." },
    { name = "write:frameworks", description = "Create framework agreements + their rate cards. Manager-only; gated by HITL in the agent UI." },
    { name = "write:projects", description = "Create projects (T&M or Fixed-Price) and their rate cards. Manager-only; gated by HITL in the agent UI." },
    { name = "write:allocations", description = "Create new project allocations and extend existing end dates. Manager-only; gated by HITL in the agent UI." },
    { name = "write:time_tracking", description = "Upsert monthly freelancer hours from bills or time sheets. Manager-only; gated by HITL in the agent UI." },
  ]
}

variable "agent_client_callback_urls" {
  description = "OAuth callback URLs allowed for the agent app client. Set this to the EVE (or other agent framework) callback URL — typically `https://<your-eve-deploy>.vercel.app/oauth/callback`. Cognito rejects any redirect_uri at /oauth2/authorize that isn't in this list, so an exfiltrated client_id alone cannot steer the consent flow to an attacker's endpoint."
  type        = list(string)
  default     = []
}

variable "agent_client_logout_urls" {
  description = "OAuth sign-out URLs allowed for the agent app client. Usually mirrors `agent_client_callback_urls` minus the `/oauth/callback` suffix."
  type        = list(string)
  default     = []
}

variable "agent_refresh_token_validity_days" {
  description = "Refresh token lifetime (days) for agent app client tokens. Default 30. Cognito's max is 3650 but anything past ~90 days makes exfiltration mitigation effectively rotation-only; pick the shortest your agent operator tolerates."
  type        = number
  default     = 30
  validation {
    condition     = var.agent_refresh_token_validity_days >= 1 && var.agent_refresh_token_validity_days <= 90
    error_message = "agent_refresh_token_validity_days must be between 1 and 90."
  }
}

variable "pre_token_generation_lambda_arn" {
  description = "ARN of the Pre Token Generation V3 Lambda. When set, Cognito calls it on every access/ID token issuance for any client (the Lambda is shared across web + agent flows but only edits agent tokens). The Lambda's job is to subset `dante-agents/*` scopes to those the user's group permits. Leave null in environments where the Lambda isn't deployed yet — agent tokens will then carry whatever scopes the user consented to, which is fine for testing the OAuth wiring."
  type        = string
  default     = null
}

