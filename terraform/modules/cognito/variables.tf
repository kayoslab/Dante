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
