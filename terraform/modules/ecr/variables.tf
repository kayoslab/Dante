variable "environment" {
  description = "Environment slug — used in repository name + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for the repository name."
  type        = string
  default     = "dante"
}

variable "image_tag_mutability" {
  description = "MUTABLE allows overwriting tags (useful for `:latest` in dev); IMMUTABLE rejects pushes that would clobber an existing tag (correct for prod — every release gets a unique SHA tag)."
  type        = string
  default     = "IMMUTABLE"

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.image_tag_mutability)
    error_message = "image_tag_mutability must be MUTABLE or IMMUTABLE."
  }
}

variable "scan_on_push" {
  description = "Run an ECR vulnerability scan on every push. Free, no reason to disable."
  type        = bool
  default     = true
}

variable "max_image_count" {
  description = "Lifecycle policy keeps this many tagged images; older ones are deleted. Storage cost is negligible (~€0.10/GB/mo) but very old images accumulate."
  type        = number
  default     = 30
}

variable "untagged_image_expiry_days" {
  description = "Untagged images (failed pushes, layer orphans) are deleted after this many days."
  type        = number
  default     = 7
}
