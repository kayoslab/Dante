variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "vpc_id" {
  description = "VPC the ALB lives in. Pass from `module.vpc.vpc_id`."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs the ALB ENIs sit in. Must be in at least 2 AZs."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An ALB requires subnets in at least 2 AZs."
  }
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS termination on port 443. Cert must be in the same region as the ALB and cover the hostname users hit."
  type        = string
}

variable "container_port" {
  description = "Port the app container listens on. Next.js's `next start` defaults to 3000."
  type        = number
  default     = 3000
}

variable "health_check_path" {
  description = "ALB target group health check path. Choose a path that responds 200 without auth and without hitting the DB — `/api/auth/csrf` is good (always present, lightweight)."
  type        = string
  default     = "/api/auth/csrf"
}

variable "idle_timeout_seconds" {
  description = "ALB idle timeout. Next.js server actions can occasionally take a few seconds; 60 is a safe default that's well below typical client timeouts."
  type        = number
  default     = 60
}

variable "access_logs_bucket" {
  description = "S3 bucket for ALB access logs. Null disables (use only if you have separate logging). Bucket must already exist with the ALB-write policy."
  type        = string
  default     = null
}

variable "access_logs_prefix" {
  description = "Prefix inside the access-logs bucket. Per-env partitions keep prod / dev logs separate."
  type        = string
  default     = "alb"
}

variable "deletion_protection" {
  description = "Block accidental destroy. Should be true for prod."
  type        = bool
  default     = true
}

variable "ingress_cidr_blocks" {
  description = "CIDRs allowed to reach the ALB on 443/80. Default open. Tighten if WAFv2 is in front or the app is only for office IPs."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
