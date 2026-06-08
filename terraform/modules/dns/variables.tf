variable "environment" {
  description = "Environment slug — used in tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for tags."
  type        = string
  default     = "dante"
}

variable "domain_name" {
  description = "Fully-qualified domain the app is served from, e.g. `dante.example.com`."
  type        = string
}

variable "hosted_zone_id" {
  description = "Existing Route 53 hosted zone ID for the parent domain (e.g. `example.com`'s zone). The module creates the A-alias record inside this zone."
  type        = string
}

variable "subject_alternative_names" {
  description = "Additional SANs on the ACM cert (e.g. `[\"www.dante.example.com\"]`). The primary `domain_name` is always included."
  type        = list(string)
  default     = []
}

variable "alb_dns_name" {
  description = "ALB DNS name to point the A-alias record at."
  type        = string
}

variable "alb_zone_id" {
  description = "ALB hosted zone ID — required for the Route 53 alias record."
  type        = string
}
