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
