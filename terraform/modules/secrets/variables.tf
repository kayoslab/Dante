variable "environment" {
  description = "Deployment environment slug (local|dev|prod). Becomes part of the secret name and the KMS alias."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names. Defaults to 'dante'."
  type        = string
  default     = "dante"
}

variable "recovery_window_in_days" {
  description = "Soft-delete window before secrets are permanently destroyed. Set to 0 to disable (useful for LocalStack which doesn't simulate the recovery window well)."
  type        = number
  default     = 7
}

variable "create_kms_key" {
  description = "When true, provision a customer-managed KMS key for envelope encryption. When false, secrets fall back to the AWS-managed key (acceptable for local dev)."
  type        = bool
  default     = true
}
