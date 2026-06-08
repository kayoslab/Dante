variable "aws_region" {
  description = "AWS region for dev resources. Frankfurt by default per GDPR."
  type        = string
  default     = "eu-central-1"
}

variable "seed_admin_emails" {
  description = "Email addresses to invite as admin users into the Cognito pool. Cognito will email a temp password to each."
  type        = list(string)
}

variable "callback_urls" {
  description = "OAuth callback URLs for the Cognito app client. Auth.js receives codes at /api/auth/callback/cognito."
  type        = list(string)
  default = [
    "http://localhost:3000/api/auth/callback/cognito",
  ]
}

variable "logout_urls" {
  description = "Sign-out redirect URLs allowed by the Cognito app client."
  type        = list(string)
  default = [
    "http://localhost:3000",
  ]
}
