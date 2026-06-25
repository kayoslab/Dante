variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "package_zip_path" {
  description = "Path to the bundled Lambda zip on disk. Built out-of-band by `npm run build:cognito-pretoken-lambda`."
  type        = string
}

variable "package_source_hash" {
  description = "Hash of the package source. Pass via `filemd5(<path>)` from the caller; changes force a Lambda code update even if `source_code_hash` is identical (which it would be on rerun of an identical build)."
  type        = string
  default     = ""
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrency for the Pre Token Gen Lambda. Token issuance is on the user-facing sign-in path so cold starts are visible — keep enough warm to handle the burst at office hours start. -1 disables the reservation (Free Plan workaround; see the matching note in the sync-lambda module)."
  type        = number
  default     = 5
}
